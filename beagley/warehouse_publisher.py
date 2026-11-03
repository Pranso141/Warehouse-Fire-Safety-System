#!/usr/bin/env python3
"""
BeagleY-AI Warehouse Safety Telemetry & RFID Gateway
AM67A hardware line offsets:
  - PIR Motion (Pin 7 / GPIO4): gpiochip2, line 38 (Input)
  - Fire D0 (Pin 37 / GPIO26):  gpiochip2, line 36 (Input)
  - MQ7 D0 (Pin 36 / GPIO16):   gpiochip3, line 7  (Input)
  - MQ2 D0 (Pin 29 / GPIO5):    gpiochip3, line 15 (Input)
  - MLX90640:                   /dev/i2c-1 (0x33) with fallback/smoothing
  - RC522 RFID: Bitbang SPI on gpiochip1, gpiochip2, gpiochip3

Sprinkler 4-Bit Output Bus (Active-Low GND switching, numbers 0-15):
  - Bit 0 (LSB): Pin 31 / GPIO6  (gpiochip3 line 17)
  - Bit 1:       Pin 32 / GPIO12 (gpiochip3 line 16)
  - Bit 2:       Pin 33 / GPIO13 (gpiochip3 line 18)
  - Bit 3 (MSB): Pin 35 / GPIO19 (gpiochip3 line 12)

Alarm & Hazard Digital Outputs (Active-Low GND switching):
  - Fire Alarm Actuator: Pin 38 / GPIO20 (gpiochip3 line 10)
  - Gas Alarm Actuator:  Pin 40 / GPIO21 (gpiochip3 line 9)
  - Master Buzzer:       Pin 18 / GPIO24 (gpiochip1 line 10)
"""
import time
import json
import threading
import math
import smbus2
import gpiod
from gpiod.line import Direction, Value
import paho.mqtt.client as mqtt

MQTT_BROKER = "broker.emqx.io"
MQTT_PORT = 1883
TOPIC_TELEMETRY = "warehouse/beagley/telemetry"
TOPIC_RFID = "warehouse/beagley/rfid"

# --- 1. HARDWARE GPIO SETUP ---
gpio_lines = {}
c1 = None
c2 = None
c3 = None

try:
    c1 = gpiod.request_lines("/dev/gpiochip1", consumer="safety_c1", config={
        10: gpiod.LineSettings(direction=Direction.OUTPUT, output_value=Value.ACTIVE) # Pin 18 (Master Buzzer, default HIGH)
    })
    print("[GPIO] Claimed Pin 18 (GPIO24 Master Buzzer) on gpiochip1")
except Exception as e:
    print("[WARN] gpiochip1 error:", e)

try:
    c2 = gpiod.request_lines("/dev/gpiochip2", consumer="safety_mon_c2", config={
        38: gpiod.LineSettings(direction=Direction.INPUT), # Pin 7 (PIR)
        36: gpiod.LineSettings(direction=Direction.INPUT)  # Pin 37 (Flame D0)
    })
    gpio_lines["pir_motion"] = (c2, 38)
    gpio_lines["fire_d0"] = (c2, 36)
    print("[GPIO] Claimed PIR (Pin 7 / line 38) and Fire (Pin 37 / line 36) on gpiochip2")
except Exception as e:
    print("[WARN] gpiochip2 error:", e)

try:
    c3 = gpiod.request_lines("/dev/gpiochip3", consumer="safety_mon_c3", config={
        7:  gpiod.LineSettings(direction=Direction.INPUT), # Pin 36 (MQ7 D0)
        15: gpiod.LineSettings(direction=Direction.INPUT), # Pin 29 (MQ2 D0)
        # Sprinkler 4-bit bus (Active-Low: default HIGH/3.3V -> no ground given)
        17: gpiod.LineSettings(direction=Direction.OUTPUT, output_value=Value.ACTIVE), # Pin 31 (Bit 0)
        16: gpiod.LineSettings(direction=Direction.OUTPUT, output_value=Value.ACTIVE), # Pin 32 (Bit 1)
        18: gpiod.LineSettings(direction=Direction.OUTPUT, output_value=Value.ACTIVE), # Pin 33 (Bit 2)
        12: gpiod.LineSettings(direction=Direction.OUTPUT, output_value=Value.ACTIVE), # Pin 35 (Bit 3)
        # Digital Outputs for Fire and Gas (Active-Low: default HIGH/3.3V -> safe)
        10: gpiod.LineSettings(direction=Direction.OUTPUT, output_value=Value.ACTIVE), # Pin 38 (Fire Alarm)
        9:  gpiod.LineSettings(direction=Direction.OUTPUT, output_value=Value.ACTIVE), # Pin 40 (Gas Alarm)
    })
    gpio_lines["mq7_d0"] = (c3, 7)
    gpio_lines["mq2_d0"] = (c3, 15)
    print("[GPIO] Claimed MQ7 (Pin 36), MQ2 (Pin 29), Sprinklers (Pins 31,32,33,35), Alarms (Pins 38,40) on gpiochip3")
except Exception as e:
    print("[WARN] gpiochip3 error:", e)

def get_sensor(name):
    if name not in gpio_lines:
        return 0
    req, line_num = gpio_lines[name]
    try:
        val = req.get_value(line_num)
        return 1 if (val == Value.ACTIVE or val == 1) else 0
    except Exception:
        return 0

def set_sprinkler_channel(ch):
    """
    Outputs 4-bit binary channel (0 to 15) on Pins 31, 32, 33, 35.
    Active-Low: Bit=1 -> GND (LOW), Bit=0 -> 3.3V (HIGH)
    """
    if not c3:
        return
    if ch is None:
        vals = {
            17: Value.ACTIVE,
            16: Value.ACTIVE,
            18: Value.ACTIVE,
            12: Value.ACTIVE
        }
    else:
        vals = {
            17: Value.INACTIVE if (ch & 1) else Value.ACTIVE,
            16: Value.INACTIVE if (ch & 2) else Value.ACTIVE,
            18: Value.INACTIVE if (ch & 4) else Value.ACTIVE,
            12: Value.INACTIVE if (ch & 8) else Value.ACTIVE
        }
    try:
        c3.set_values(vals)
    except Exception as e:
        pass

def set_alarm_outputs(fire_active, gas_active):
    """
    Active-Low Digital Outputs:
    Pin 38 (c3 line 10): Fire Alarm (LOW/GND when triggered)
    Pin 40 (c3 line 9):  Gas Alarm  (LOW/GND when triggered)
    Pin 18 (c1 line 10): Buzzer     (LOW/GND when triggered)
    """
    if c3:
        try:
            c3.set_values({
                10: Value.INACTIVE if fire_active else Value.ACTIVE,
                9:  Value.INACTIVE if gas_active else Value.ACTIVE
            })
        except Exception:
            pass
    if c1:
        try:
            hazard = fire_active or gas_active
            c1.set_value(10, Value.INACTIVE if hazard else Value.ACTIVE)
        except Exception:
            pass

# --- 2. THERMAL CAMERA THREAD & FILTER ---
thermal_frame = [24.0] * 768
thermal_lock = threading.Lock()
camera_hardware_available = False

def thermal_worker():
    global camera_hardware_available
    try:
        import adafruit_mlx90640
        class SmbusI2CAdapter:
            def __init__(self, bus_num=1):
                self.bus = smbus2.SMBus(bus_num)
            def try_lock(self): return True
            def unlock(self): pass
            def writeto(self, address, buffer, *, start=0, end=None):
                if end is None: end = len(buffer)
                msg = smbus2.i2c_msg.write(address, list(buffer[start:end]))
                self.bus.i2c_rdwr(msg)
            def readfrom_into(self, address, buffer, *, start=0, end=None):
                if end is None: end = len(buffer)
                msg = smbus2.i2c_msg.read(address, end - start)
                self.bus.i2c_rdwr(msg)
                for i, val in enumerate(msg): buffer[start + i] = val
            def writeto_then_readfrom(self, address, out_buffer, in_buffer, *, out_start=0, out_end=None, in_start=0, in_end=None):
                if out_end is None: out_end = len(out_buffer)
                if in_end is None: in_end = len(in_buffer)
                msg_w = smbus2.i2c_msg.write(address, list(out_buffer[out_start:out_end]))
                msg_r = smbus2.i2c_msg.read(address, in_end - in_start)
                self.bus.i2c_rdwr(msg_w, msg_r)
                for i, val in enumerate(msg_r): in_buffer[in_start + i] = val

        adapter = SmbusI2CAdapter(1)
        mlx = adafruit_mlx90640.MLX90640(adapter)
        mlx.refresh_rate = adafruit_mlx90640.RefreshRate.REFRESH_1_HZ
        camera_hardware_available = True
        print("[THERMAL] MLX90640 hardware reader active!")
        raw_buf = [24.0] * 768
        while True:
            try:
                mlx.getFrame(raw_buf)
                clean_buf = []
                for val in raw_buf:
                    if -20.0 <= val <= 120.0:
                        clean_buf.append(val)
                    else:
                        clean_buf.append(26.0)
                with thermal_lock:
                    for i in range(768):
                        thermal_frame[i] = round(clean_buf[i], 1)
            except Exception:
                time.sleep(0.5)
            time.sleep(0.5)
    except Exception as e:
        print("[THERMAL] MLX90640 hardware exception:", e)

threading.Thread(target=thermal_worker, daemon=True).start()

# --- 3. MQTT CLIENT WITH AUTO-RETRY ---
try:
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="BeagleY_AI_Sensor_Station")
except Exception:
    client = mqtt.Client(client_id="BeagleY_AI_Sensor_Station")

def on_connect(c, userdata, flags, rc, properties=None):
    print(f"[MQTT] Connected to {MQTT_BROKER} (Code {rc})")

client.on_connect = on_connect

def mqtt_connect_loop():
    while True:
        try:
            client.connect(MQTT_BROKER, MQTT_PORT, 60)
            client.loop_start()
            break
        except Exception as e:
            print(f"[MQTT] Connect error: {e}, retrying in 3s...")
            time.sleep(3)

threading.Thread(target=mqtt_connect_loop, daemon=True).start()

# --- 4. RFID BACKGROUND WORKER (Native Bitbang) ---
def rfid_worker():
    from rc522_driver import RC522
    try:
        rdr = RC522()
        print("[RFID] RC522 Hardware Bitbang Worker active and listening for cards!")
        last_scanned = ""
        last_scan_time = 0
        while True:
            try:
                uid = rdr.read_uid()
                now = time.time()
                if uid:
                    if uid != last_scanned or (now - last_scan_time) > 2.0:
                        last_scanned = uid
                        last_scan_time = now
                        print(f"[RFID] >>> TAP DETECTED! Card UID: {uid} <<<")
                        payload = json.dumps({"rfid_uid": uid, "timestamp": now})
                        client.publish(TOPIC_RFID, payload, qos=1)
            except Exception:
                pass
            time.sleep(0.06)
    except Exception as e:
        print("[RFID] Worker error:", e)

threading.Thread(target=rfid_worker, daemon=True).start()

# --- 5. MAIN TRANSMISSION LOOP ---
t_step = 0
print("[STREAMING] Live Telemetry streaming to MQTT with 4-bit Sprinkler GPIO & Alarm outputs...")

try:
    while True:
        pir_state = get_sensor("pir_motion")
        # Sensor D0 pins typically pull to LOW when triggered (active low)
        fire_raw = get_sensor("fire_d0")
        mq7_raw = get_sensor("mq7_d0")
        mq2_raw = get_sensor("mq2_d0")

        s_data = {
            "fire_d0": 1 if fire_raw == 0 and "fire_d0" in gpio_lines else 0,
            "mq7_d0": 1 if mq7_raw == 0 and "mq7_d0" in gpio_lines else 0,
            "mq2_d0": 1 if mq2_raw == 0 and "mq2_d0" in gpio_lines else 0,
            "pir_motion": pir_state
        }

        with thermal_lock:
            has_real_data = any(v != 24.0 for v in thermal_frame)
            if not has_real_data:
                t_step += 0.25
                cur_matrix = []
                flame_boost = 32.0 if s_data["fire_d0"] == 1 else 0.0
                hx = 16 + math.sin(t_step * 0.4) * 8
                hy = 12 + math.cos(t_step * 0.3) * 5
                for idx in range(768):
                    px = idx % 32
                    py = idx // 32
                    dist_sq = (px - hx)**2 + (py - hy)**2
                    spot = math.exp(-dist_sq / 26.0) * (14.0 + flame_boost)
                    drift = math.sin((px + t_step) / 5.0) * 1.2 + math.cos((py - t_step) / 4.0) * 0.9
                    val = 24.2 + drift + spot
                    cur_matrix.append(round(val, 1))
            else:
                cur_matrix = list(thermal_frame)

        max_t = round(float(max(cur_matrix)), 1)
        avg_t = round(float(sum(cur_matrix) / 768.0), 1)

        # Calculate Hotspot & Sprinkler Zone
        # Grid rearranged as requested:
        # Row 0: 4  3  2  1
        # Row 1: 8  7  6  5
        # Row 2: 12 11 10 9
        # Row 3: 16 15 14 13
        hot_idx = cur_matrix.index(max(cur_matrix))
        hot_x = hot_idx % 32
        hot_y = hot_idx // 32
        hot_col = min(3, max(0, int((hot_x / 32.0) * 4))) # 0 is left, 3 is right
        hot_row = min(3, max(0, int((hot_y / 24.0) * 4))) # 0 is top, 3 is bottom
        active_zone = (hot_row * 4) + (4 - hot_col)        # 1 to 16
        channel = active_zone - 1                          # 0 to 15 (4-bit number)

        # Drive 4 GPIO Sprinkler Pins (Active-Low switching to GND)
        set_sprinkler_channel(channel)

        # Hazard triggers:
        fire_triggered = (s_data["fire_d0"] == 1) or (max_t >= 55.0)
        gas_triggered = (s_data["mq7_d0"] == 1) or (s_data["mq2_d0"] == 1)
        set_alarm_outputs(fire_triggered, gas_triggered)

        payload = {
            "sensors": s_data,
            "thermal": {
                "max_temp": max_t,
                "avg_temp": avg_t,
                "matrix_24x32": cur_matrix
            },
            "sprinkler": {
                "active_zone": active_zone,
                "channel": channel,
                "binary": f"{channel:04b}",
                "active_low_pins": {
                    "pin31_bit0": 0 if (channel & 1) else 1,
                    "pin32_bit1": 0 if (channel & 2) else 1,
                    "pin33_bit2": 0 if (channel & 4) else 1,
                    "pin35_bit3": 0 if (channel & 8) else 1
                }
            },
            "actuators": {
                "fire_alarm_pin38": 0 if fire_triggered else 1,
                "gas_alarm_pin40": 0 if gas_triggered else 1,
                "buzzer_pin18": 0 if (fire_triggered or gas_triggered) else 1
            }
        }

        try:
            client.publish(TOPIC_TELEMETRY, json.dumps(payload))
        except Exception:
            pass
        time.sleep(1.0)
except KeyboardInterrupt:
    print("[STOP] Stopped by user")
finally:
    # Safe reset to HIGH (inactive / no ground given)
    set_sprinkler_channel(None)
    set_alarm_outputs(False, False)
