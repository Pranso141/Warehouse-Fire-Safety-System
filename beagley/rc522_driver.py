import time
import gpiod
from gpiod.line import Direction, Value

# AM67A BeagleY Pin mapping:
# CS:   GPIO17 -> gpiochip3 line 8
# SCK:  GPIO27 -> gpiochip2 line 33
# MOSI: GPIO22 -> gpiochip2 line 41
# MISO: GPIO23 -> gpiochip1 line 7
# RST:  GPIO25 -> gpiochip2 line 42

class RC522:
    def __init__(self):
        self.chip1 = gpiod.request_lines("/dev/gpiochip1", consumer="rc522_miso", config={
            7: gpiod.LineSettings(direction=Direction.INPUT)
        })
        self.chip2 = gpiod.request_lines("/dev/gpiochip2", consumer="rc522_c2", config={
            33: gpiod.LineSettings(direction=Direction.OUTPUT, output_value=Value.INACTIVE),
            41: gpiod.LineSettings(direction=Direction.OUTPUT, output_value=Value.INACTIVE),
            42: gpiod.LineSettings(direction=Direction.OUTPUT, output_value=Value.ACTIVE)
        })
        self.chip3 = gpiod.request_lines("/dev/gpiochip3", consumer="rc522_cs", config={
            8: gpiod.LineSettings(direction=Direction.OUTPUT, output_value=Value.ACTIVE)
        })
        self.init()

    def spi_transfer(self, b):
        recv = 0
        for i in range(8):
            bit = (b >> (7 - i)) & 1
            self.chip2.set_value(41, Value.ACTIVE if bit else Value.INACTIVE)
            self.chip2.set_value(33, Value.ACTIVE) # SCK high
            if self.chip1.get_value(7) in [Value.ACTIVE, 1]:
                recv |= (1 << (7 - i))
            self.chip2.set_value(33, Value.INACTIVE) # SCK low
        return recv

    def write_reg(self, addr, val):
        self.chip3.set_value(8, Value.INACTIVE)
        self.spi_transfer((addr << 1) & 0x7E)
        self.spi_transfer(val)
        self.chip3.set_value(8, Value.ACTIVE)

    def read_reg(self, addr):
        self.chip3.set_value(8, Value.INACTIVE)
        self.spi_transfer(((addr << 1) & 0x7E) | 0x80)
        val = self.spi_transfer(0x00)
        self.chip3.set_value(8, Value.ACTIVE)
        return val

    def set_bit_mask(self, reg, mask):
        curr = self.read_reg(reg)
        self.write_reg(reg, curr | mask)

    def clear_bit_mask(self, reg, mask):
        curr = self.read_reg(reg)
        self.write_reg(reg, curr & (~mask))

    def init(self):
        # Hardware reset pulse
        self.chip2.set_value(42, Value.INACTIVE)
        time.sleep(0.01)
        self.chip2.set_value(42, Value.ACTIVE)
        time.sleep(0.05)

        # Soft reset
        self.write_reg(0x01, 0x0F)
        time.sleep(0.05)

        self.write_reg(0x2A, 0x8D) # TModeReg
        self.write_reg(0x2B, 0x3E) # TPrescalerReg
        self.write_reg(0x2D, 30)   # TReloadRegL
        self.write_reg(0x2C, 0)    # TReloadRegH
        self.write_reg(0x15, 0x40) # TxASKReg: 100% ASK modulation
        self.write_reg(0x11, 0x3D) # ModeReg: CRC initial value 0x6363

        # Set antenna gain to maximum (48dB) for sensitive card detection
        self.set_bit_mask(0x26, 0x70)

        # Turn on antenna (TxControlReg: Tx1RFEn | Tx2RFEn)
        self.set_bit_mask(0x14, 0x03)

    def to_card(self, command, send_data):
        back_data = []
        back_len = 0
        status = False
        irq_en = 0x00
        wait_irq = 0x00

        if command == 0x0E: # Authent
            irq_en = 0x12
            wait_irq = 0x10
        if command == 0x0C: # Transceive
            irq_en = 0x77
            wait_irq = 0x30

        self.write_reg(0x02, irq_en | 0x80)
        self.clear_bit_mask(0x04, 0x80)
        self.set_bit_mask(0x0A, 0x80)
        self.write_reg(0x01, 0x00)

        for byte in send_data:
            self.write_reg(0x09, byte)

        self.write_reg(0x01, command)
        if command == 0x0C:
            self.set_bit_mask(0x0D, 0x80)

        i = 2500
        while i > 0:
            n = self.read_reg(0x04)
            if n & wait_irq:
                break
            if n & 0x01:
                break
            i -= 1

        self.clear_bit_mask(0x0D, 0x80)

        if i != 0:
            err = self.read_reg(0x06)
            if not (err & 0x1B):
                status = True
                if n & irq_en & 0x01:
                    status = False
                if command == 0x0C:
                    fifo_len = self.read_reg(0x0A)
                    last_bits = self.read_reg(0x0C) & 0x07
                    if last_bits != 0:
                        back_len = (fifo_len - 1) * 8 + last_bits
                    else:
                        back_len = fifo_len * 8
                    if fifo_len == 0:
                        fifo_len = 1
                    if fifo_len > 16:
                        fifo_len = 16
                    for _ in range(fifo_len):
                        back_data.append(self.read_reg(0x09))
            else:
                status = False

        return status, back_data, back_len

    def request(self, req_mode=0x26):
        self.write_reg(0x0D, 0x07)
        status, back_data, back_bits = self.to_card(0x0C, [req_mode])
        if (not status) or (back_bits != 0x10):
            status = False
        return status, back_bits

    def anticoll(self):
        self.write_reg(0x0D, 0x00)
        status, back_data, _ = self.to_card(0x0C, [0x93, 0x20])
        if status and len(back_data) >= 5:
            ser_num_check = 0
            for i in range(4):
                ser_num_check ^= back_data[i]
            if ser_num_check != back_data[4]:
                status = False
        else:
            status = False
        return status, back_data

    def read_uid(self):
        status, _ = self.request(0x26)
        if not status:
            status, _ = self.request(0x52)
        if status:
            status, uid = self.anticoll()
            if status and len(uid) >= 4:
                return "".join(["%02X" % x for x in uid[:4]])
        return None

if __name__ == "__main__":
    reader = RC522()
    ver = reader.read_reg(0x37)
    print("RC522 initialized! Reg 0x37 Version:", hex(ver))
