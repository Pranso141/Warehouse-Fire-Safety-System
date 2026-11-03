import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Server as HttpServer } from "node:http";
import mqtt, { type MqttClient } from "mqtt";
import { Server as SocketIOServer } from "socket.io";
import { logger } from "./logger";

export type SafetySeverity = "normal" | "warning" | "critical";

export interface SafetyEvent {
  id: string;
  timestamp: Date;
  severity: SafetySeverity;
  source: string;
  message: string;
}

export interface SafetyState {
  mqttConnected: boolean;
  mqttUrlConfigured: boolean;
  lastUpdated: Date | null;
  sensors: {
    fire_d0: number;
    mq7_d0: number;
    mq2_d0: number;
    pir_motion: number;
  };
  thermal: {
    max_temp: number;
    avg_temp: number;
    matrix_24x32: number[];
  };
}

interface MqttTelemetry {
  sensors: SafetyState["sensors"];
  thermal: SafetyState["thermal"];
}

const mqttUrl = process.env.MQTT_URL;
function normalizeRfidUid(uid: string): string {
  return uid.trim().toUpperCase().replace(/[\s:-]/g, "");
}

const configuredRfidUids = (process.env.RFID_ALLOWED_UIDS ?? "5281A25C,5299945C")
  .split(",")
  .map(normalizeRfidUid)
  .filter(Boolean);
const allowedRfidUids = new Set(
  configuredRfidUids,
);
allowedRfidUids.add("5281A25C");
allowedRfidUids.add("5299945C");
const bus = new EventEmitter();
const recentEvents: SafetyEvent[] = [];

let state: SafetyState = {
  mqttConnected: false,
  mqttUrlConfigured: Boolean(mqttUrl),
  lastUpdated: null,
  sensors: {
    fire_d0: 0,
    mq7_d0: 0,
    mq2_d0: 0,
    pir_motion: 0,
  },
  thermal: {
    max_temp: 22,
    avg_temp: 22,
    matrix_24x32: Array.from({ length: 24 * 32 }, () => 22),
  },
};

function addEvent(
  severity: SafetySeverity,
  source: string,
  message: string,
): SafetyEvent {
  const event: SafetyEvent = {
    id: randomUUID(),
    timestamp: new Date(),
    severity,
    source,
    message,
  };
  recentEvents.unshift(event);
  recentEvents.length = Math.min(recentEvents.length, 100);
  bus.emit("safety:event", event);
  return event;
}

export function authorizeManualRfid(uid: string): boolean {
  const normalizedUid = normalizeRfidUid(uid);
  const authorized = normalizedUid.length > 0 && allowedRfidUids.has(normalizedUid);
  const maskedUid = normalizedUid.slice(-4).padStart(Math.min(normalizedUid.length, 4), "•");
  addEvent(
    authorized ? "normal" : "warning",
    "RFID MANUAL",
    `Manual credential ${maskedUid} ${authorized ? "accepted" : "rejected"}`,
  );
  return authorized;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return null;
}

function flattenMatrix(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const flat = value.length === 24 && value.every(Array.isArray)
    ? value.flat()
    : value;
  if (flat.length !== 768) {
    return null;
  }

  const numbers = flat.map(asNumber);
  return numbers.every((number): number is number => number !== null)
    ? numbers
    : null;
}

function parseTelemetry(payload: unknown): MqttTelemetry | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const data = payload as Record<string, unknown>;
  const sensorPayload = data.sensors;
  const thermalPayload = data.thermal;
  if (!sensorPayload || typeof sensorPayload !== "object" ||
      !thermalPayload || typeof thermalPayload !== "object") {
    return null;
  }

  const sensors = sensorPayload as Record<string, unknown>;
  const thermal = thermalPayload as Record<string, unknown>;
  const fire = asNumber(sensors.fire_d0);
  const co = asNumber(sensors.mq7_d0);
  const gas = asNumber(sensors.mq2_d0);
  const motion = asNumber(sensors.pir_motion);
  const maxTemp = asNumber(thermal.max_temp);
  const avgTemp = asNumber(thermal.avg_temp);
  const matrix = flattenMatrix(thermal.matrix_24x32);

  if (
    fire === null ||
    co === null ||
    gas === null ||
    motion === null ||
    maxTemp === null ||
    avgTemp === null ||
    matrix === null
  ) {
    return null;
  }

  return {
    sensors: {
      fire_d0: fire,
      mq7_d0: co,
      mq2_d0: gas,
      pir_motion: motion,
    },
    thermal: {
      max_temp: maxTemp,
      avg_temp: avgTemp,
      matrix_24x32: matrix,
    },
  };
}

let lastConditionSignature = "";

function recordTelemetryConditions(telemetry: MqttTelemetry): void {
  const { sensors, thermal } = telemetry;
  const temperatureSeverity: SafetySeverity =
    thermal.max_temp >= 75 ? "critical" :
    thermal.max_temp >= 55 ? "warning" :
    "normal";
  const activeConditions = [
    sensors.fire_d0 >= 1 ? "flame" : "",
    sensors.mq7_d0 >= 1 ? "co" : "",
    sensors.mq2_d0 >= 1 ? "gas" : "",
    temperatureSeverity !== "normal" ? `temperature-${temperatureSeverity}` : "",
  ].filter(Boolean);
  const signature = activeConditions.join("|");
  if (signature === lastConditionSignature) {
    return;
  }

  const previous = new Set(lastConditionSignature.split("|").filter(Boolean));
  const current = new Set(activeConditions);
  for (const condition of current) {
    if (previous.has(condition)) {
      continue;
    }
    if (condition === "flame") {
      addEvent("critical", "Flame sensor", "Flame signal detected (GPIO 26 high)");
    } else if (condition === "co") {
      addEvent("critical", "CO sensor", "CO hazard signal detected (GPIO 17 high)");
    } else if (condition === "gas") {
      addEvent("critical", "Gas sensor", "Flammable gas signal detected (GPIO 4 high)");
    } else if (condition === "temperature-warning") {
      addEvent("warning", "Thermal camera", `Temperature elevated: ${thermal.max_temp.toFixed(1)} °C`);
    } else if (condition === "temperature-critical") {
      addEvent("critical", "Thermal camera", `High temperature detected: ${thermal.max_temp.toFixed(1)} °C`);
    }
  }

  for (const condition of previous) {
    if (!current.has(condition)) {
      addEvent("normal", "Sensor status", `${condition.replaceAll("-", " ")} condition cleared`);
    }
  }

  lastConditionSignature = signature;
}

function applyTelemetry(telemetry: MqttTelemetry): void {
  state = {
    ...state,
    sensors: telemetry.sensors,
    thermal: telemetry.thermal,
    lastUpdated: new Date(),
  };
  recordTelemetryConditions(telemetry);
  bus.emit("safety:state", state);
}

export function getSafetyState(): SafetyState {
  return { ...state, sensors: { ...state.sensors }, thermal: { ...state.thermal } };
}

export function getSafetyEvents(): SafetyEvent[] {
  return [...recentEvents];
}

function connectMqtt(): MqttClient | null {
  if (!mqttUrl) {
    addEvent("warning", "MQTT", "No MQTT_URL configured; live telemetry is unavailable");
    return null;
  }

  const client = mqtt.connect(mqttUrl, {
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    clean: true,
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
  });

  client.on("connect", () => {
    state = { ...state, mqttConnected: true, mqttUrlConfigured: true };
    client.subscribe(
      ["warehouse/beagley/telemetry", "warehouse/beagley/rfid"],
      { qos: 0 },
      (error) => {
        if (error) {
          logger.warn("MQTT topic subscription failed");
          return;
        }
        addEvent("normal", "MQTT", "Connected and subscribed to BeagleY-AI topics");
        bus.emit("safety:status", getSafetyState());
      },
    );
  });

  client.on("reconnect", () => {
    state = { ...state, mqttConnected: false };
    bus.emit("safety:status", getSafetyState());
  });

  client.on("close", () => {
    state = { ...state, mqttConnected: false };
    bus.emit("safety:status", getSafetyState());
  });

  client.on("error", () => {
    logger.warn("MQTT broker connection error; retrying");
  });

  client.on("message", (topic, message) => {
    let data: unknown;
    try {
      data = JSON.parse(message.toString());
    } catch {
      addEvent("warning", "MQTT", `Invalid JSON received on ${topic}`);
      return;
    }

    if (topic === "warehouse/beagley/telemetry") {
      const telemetry = parseTelemetry(data);
      if (!telemetry) {
        addEvent("warning", "MQTT", "Telemetry payload did not match the expected sensor format");
        return;
      }
      applyTelemetry(telemetry);
      return;
    }

    if (topic === "warehouse/beagley/rfid") {
      if (!data || typeof data !== "object") {
        return;
      }
      const record = data as Record<string, unknown>;
      if (typeof record.rfid_uid !== "string" || !record.rfid_uid.trim()) {
        return;
      }
      const uid = normalizeRfidUid(record.rfid_uid);
      if (!uid) {
        return;
      }
      const authorized = allowedRfidUids.has(uid);
      const timestamp = typeof record.timestamp === "string" ||
          typeof record.timestamp === "number"
        ? record.timestamp
        : new Date().toISOString();
      addEvent(
        authorized ? "normal" : "warning",
        "RFID",
        `Card ${uid.slice(-4).padStart(Math.min(uid.length, 4), "•")} tapped${authorized ? " — authorized" : " — not registered"}`,
      );
      bus.emit("safety:rfid", { uid, authorized, timestamp });
    }
  });

  return client;
}

export function initializeSafetyRealtime(httpServer: HttpServer): void {
  const io = new SocketIOServer(httpServer, {
    path: "/api/socket.io",
    cors: { origin: true, credentials: true },
  });

  io.on("connection", (socket) => {
    socket.emit("safety:state", getSafetyState());
    socket.emit("safety:events", getSafetyEvents());
  });

  bus.on("safety:state", (nextState: SafetyState) => {
    io.emit("safety:state", nextState);
  });
  bus.on("safety:status", (nextState: SafetyState) => {
    io.emit("safety:status", nextState);
  });
  bus.on("safety:event", (event: SafetyEvent) => {
    io.emit("safety:event", event);
  });
  bus.on("safety:rfid", (event: {
    uid: string;
    authorized: boolean;
    timestamp: string | number;
  }) => {
    io.emit("safety:rfid", event);
  });

  connectMqtt();
}
