import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  Circle,
  Cloud,
  Flame,
  Gauge,
  KeyRound,
  LockKeyhole,
  Radio,
  RefreshCw,
  ShieldCheck,
  ShieldEllipsis,
  Signal,
  Thermometer,
  Volume2,
  VolumeX,
  Waves,
  Wifi,
  Wind,
  Zap,
} from 'lucide-react';
import { io, type Socket } from 'socket.io-client';
import {
  getGetSafetyEventsQueryKey,
  getGetSafetyStateQueryKey,
  useGetSafetyEvents,
  useGetSafetyState,
} from '@workspace/api-client-react';
import type { SafetyEvent, SafetyState } from '@workspace/api-client-react';
import { ThermalMap } from '@/components/ThermalMap';
import { UnlockModal } from '@/components/UnlockModal';
import '@/dashboard.css';

type DisplaySize = 4 | 6;

interface LiveRfidPayload {
  uid?: string;
  authorized?: boolean;
  timestamp?: string | number;
}

const demoEvents: SafetyEvent[] = [
  { id: 'demo-01', timestamp: new Date(Date.now() - 85000).toISOString(), severity: 'normal', source: 'THERMAL-A', message: 'Thermal field stable · peak 23.8°C' },
  { id: 'demo-02', timestamp: new Date(Date.now() - 260000).toISOString(), severity: 'normal', source: 'MQTT-BRIDGE', message: 'Broker heartbeat received · 38 ms' },
  { id: 'demo-03', timestamp: new Date(Date.now() - 522000).toISOString(), severity: 'warning', source: 'PIR-ZONE-04', message: 'Transient motion event · aisle 4' },
  { id: 'demo-04', timestamp: new Date(Date.now() - 740000).toISOString(), severity: 'normal', source: 'AUTH-GATE', message: 'Dashboard session initialized · locked' },
];

function makeDemoState(tick: number): SafetyState {
  const matrix = Array.from({ length: 768 }, (_, index) => {
    const x = index % 32;
    const y = Math.floor(index / 32);
    const drift = Math.sin((tick + x) / 7) * 0.45;
    const plume = Math.exp(-((x - (20 + Math.sin(tick / 12) * 2)) ** 2 + (y - 10) ** 2) / 40) * 7.4;
    return Number((21.5 + Math.sin(x / 5.3) * 0.8 + Math.cos(y / 4.4) * 0.65 + drift + plume).toFixed(1));
  });
  const maxTemp = Math.max(...matrix);
  const avgTemp = matrix.reduce((total, value) => total + value, 0) / matrix.length;
  return {
      mqttConnected: false,
      mqttUrlConfigured: false,
    lastUpdated: new Date().toISOString(),
    sensors: {
      fire_d0: 0,
      mq7_d0: 0,
      mq2_d0: 0,
      pir_motion: tick % 16 < 3 ? 1 : 0,
    },
    thermal: { max_temp: maxTemp, avg_temp: avgTemp, matrix_24x32: matrix },
  };
}

function formatClock(date: Date) {
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

function formatAge(value: string | null | undefined) {
  if (!value) {
    return 'Awaiting signal';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Awaiting signal' : date.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function StatCard({
  label,
  tag,
  value,
  unit,
  status,
  statusText,
  icon: Icon,
  trend,
  detail,
}: {
  label: string;
  tag: string;
  value: string;
  unit?: string;
  status: 'normal' | 'warning' | 'critical' | 'offline';
  statusText: string;
  icon: typeof Flame;
  trend?: 'up' | 'down';
  detail: string;
}) {
  return (
    <article className={`sensor-card sensor-${status}`} data-testid={`card-sensor-${tag.toLowerCase()}`}>
      <div className="sensor-card-top">
        <span className="sensor-icon"><Icon size={16} strokeWidth={1.8} /></span>
        <span className="sensor-tag mono-font">{tag}</span>
        <span className={`state-chip state-${status}`}><span />{statusText}</span>
      </div>
      <div className="sensor-card-label">{label}</div>
      <div className="sensor-reading">
        <strong>{value}</strong>
        {unit && <span>{unit}</span>}
        {trend && <span className={`reading-trend trend-${trend}`}>{trend === 'up' ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}</span>}
      </div>
      <div className="sensor-card-foot">
        <span>{detail}</span>
        <span className="sensor-live"><i />LIVE</span>
      </div>
    </article>
  );
}

function SprinklerStatus({
  displaySize,
  onDisplaySizeChange,
  telemetryAvailable,
  maxTemp,
  hotX,
  hotY,
}: {
  displaySize: DisplaySize;
  onDisplaySizeChange: (size: DisplaySize) => void;
  telemetryAvailable: boolean;
  maxTemp: number;
  hotX: number;
  hotY: number;
}) {
  const zoneCount = displaySize * displaySize;
  const hotZoneX = Math.min(displaySize - 1, Math.floor((hotX / 32) * displaySize));
  const hotZoneY = Math.min(displaySize - 1, Math.floor((hotY / 24) * displaySize));
  const hotZoneIndex = hotZoneY * displaySize + hotZoneX;
  const hotspotStatus = !telemetryAvailable
    ? 'unknown'
    : maxTemp >= 75
      ? 'active'
      : maxTemp >= 55
        ? 'primed'
        : 'idle';

  // 4x4 Grid rearranged per hardware alignment:
  // Row 0: 4  3  2  1
  // Row 1: 8  7  6  5
  // Row 2: 12 11 10 9
  // Row 3: 16 15 14 13
  const gridLayout4x4 = [
    4,  3,  2,  1,
    8,  7,  6,  5,
    12, 11, 10, 9,
    16, 15, 14, 13,
  ];

  const cells = useMemo(() => {
    if (displaySize === 4) {
      return gridLayout4x4.map((zoneId, index) => {
        const channel = zoneId - 1; // 0 to 15
        const isHot = telemetryAvailable && index === hotZoneIndex;
        return {
          id: zoneId,
          channel,
          binary: channel.toString(2).padStart(4, '0'),
          state: !telemetryAvailable ? 'unknown' : isHot ? hotspotStatus : 'idle',
          isHotspot: isHot,
        };
      });
    }
    return Array.from({ length: zoneCount }, (_, index) => ({
      id: index + 1,
      channel: index,
      binary: index.toString(2).padStart(4, '0'),
      state: !telemetryAvailable ? 'unknown' : index === hotZoneIndex ? hotspotStatus : 'idle',
      isHotspot: telemetryAvailable && index === hotZoneIndex,
    }));
  }, [displaySize, hotZoneIndex, hotspotStatus, telemetryAvailable, zoneCount]);

  const activeCell = cells.find((cell) => cell.isHotspot);
  const activeChannel = activeCell ? activeCell.channel : null;
  const activeBin = activeCell ? activeCell.binary : '0000';

  const counts = {
    idle: cells.filter((cell) => cell.state === 'idle').length,
    primed: cells.filter((cell) => cell.state === 'primed').length,
    active: cells.filter((cell) => cell.state === 'active').length,
    unknown: cells.filter((cell) => cell.state === 'unknown').length,
  };

  return (
    <section className="panel sprinkler-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-marker marker-teal" /> 4-BIT HARDWARE GPIO &bull; 0 TO 15 BUS</div>
          <h2 className="panel-title">Sprinkler zones</h2>
        </div>
        <div className="sprinkler-size-control" role="group" aria-label="Sprinkler zone grid size">
          {[4, 6].map((size) => (
            <button
              type="button"
              key={size}
              className={displaySize === size ? 'display-option active' : 'display-option'}
              aria-pressed={displaySize === size}
              onClick={() => onDisplaySizeChange(size as DisplaySize)}
              data-testid={`button-sprinkler-grid-${size}x${size}`}
            >
              {size}×{size}
            </button>
          ))}
        </div>
      </div>
      <div className="sprinkler-summary">
        <div className="sprinkler-count"><strong>{String(counts.idle).padStart(2, '0')}</strong><span>Idle</span></div>
        <div className="sprinkler-count sprinkler-caution"><strong>{String(counts.primed).padStart(2, '0')}</strong><span>Primed</span></div>
        <div className="sprinkler-count sprinkler-active-count"><strong>{String(counts.active).padStart(2, '0')}</strong><span>Active suppression</span></div>
        <div className="sprinkler-count"><strong>{String(counts.unknown).padStart(2, '0')}</strong><span>Unknown</span></div>
      </div>

      {/* Hardware 4-bit GPIO Bus status indicator */}
      <div style={{ margin: '8px 0', padding: '10px', background: '#111720', border: '1px solid #1f2b38', borderRadius: '6px', fontSize: '11px', fontFamily: 'monospace' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px', flexWrap: 'wrap', gap: '4px' }}>
          <span><b>ACTIVE 4-BIT BUS:</b> <span style={{ color: '#fbbf24' }}>{activeChannel !== null ? `CH ${String(activeChannel).padStart(2, '0')} (ZONE ${String(activeCell?.id).padStart(2, '0')})` : 'STANDBY'}</span></span>
          <span>BIN: <b style={{ color: '#34d399' }}>{activeBin}</b> (ACTIVE-LOW GND)</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px', textAlign: 'center', fontSize: '9px' }}>
          <div style={{ padding: '3px', background: activeChannel !== null && (activeChannel & 8) ? '#064e3b' : '#1c2430', color: activeChannel !== null && (activeChannel & 8) ? '#34d399' : '#94a3b8', borderRadius: '4px', border: activeChannel !== null && (activeChannel & 8) ? '1px solid #059669' : '1px solid #2d3748' }}>
            <div><b>B3 (MSB)</b></div>
            <div>Pin 35: {activeChannel !== null && (activeChannel & 8) ? 'GND (0)' : '3.3V (1)'}</div>
          </div>
          <div style={{ padding: '3px', background: activeChannel !== null && (activeChannel & 4) ? '#064e3b' : '#1c2430', color: activeChannel !== null && (activeChannel & 4) ? '#34d399' : '#94a3b8', borderRadius: '4px', border: activeChannel !== null && (activeChannel & 4) ? '1px solid #059669' : '1px solid #2d3748' }}>
            <div><b>B2</b></div>
            <div>Pin 33: {activeChannel !== null && (activeChannel & 4) ? 'GND (0)' : '3.3V (1)'}</div>
          </div>
          <div style={{ padding: '3px', background: activeChannel !== null && (activeChannel & 2) ? '#064e3b' : '#1c2430', color: activeChannel !== null && (activeChannel & 2) ? '#34d399' : '#94a3b8', borderRadius: '4px', border: activeChannel !== null && (activeChannel & 2) ? '1px solid #059669' : '1px solid #2d3748' }}>
            <div><b>B1</b></div>
            <div>Pin 32: {activeChannel !== null && (activeChannel & 2) ? 'GND (0)' : '3.3V (1)'}</div>
          </div>
          <div style={{ padding: '3px', background: activeChannel !== null && (activeChannel & 1) ? '#064e3b' : '#1c2430', color: activeChannel !== null && (activeChannel & 1) ? '#34d399' : '#94a3b8', borderRadius: '4px', border: activeChannel !== null && (activeChannel & 1) ? '1px solid #059669' : '1px solid #2d3748' }}>
            <div><b>B0 (LSB)</b></div>
            <div>Pin 31: {activeChannel !== null && (activeChannel & 1) ? 'GND (0)' : '3.3V (1)'}</div>
          </div>
        </div>
      </div>

      <div className="sprinkler-grid" style={{ gridTemplateColumns: `repeat(${displaySize}, minmax(0, 1fr))` }}>
        {cells.map((cell) => (
          <div className={`sprinkler-cell sprinkler-${cell.state} ${cell.isHotspot ? 'sprinkler-hotspot' : ''}`} key={cell.id} data-testid={`status-sprinkler-zone-${cell.id}`} style={{ padding: '4px 6px', minHeight: '36px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.1 }}>
              <span>Z{String(cell.id).padStart(2, '0')}</span>
              <span style={{ fontSize: '7px', opacity: 0.8, fontFamily: 'monospace' }}>CH {cell.channel}</span>
            </div>
            <small>{cell.state === 'active' ? 'ACTIVE' : cell.state.toUpperCase()}</small>
            <i />
          </div>
        ))}
      </div>
      <div className="status-only-note">
        <ShieldEllipsis size={15} />
        <span>HARDWARE ACTIVE-LOW SWITCHING &bull; PINS 31, 32, 33, 35 PULL TO GROUND</span>
      </div>
    </section>
  );
}

function SensorHealth({ state, telemetryAvailable }: { state: SafetyState; telemetryAvailable: boolean }) {
  const fireActive = state.sensors.fire_d0 >= 1 || state.thermal.max_temp >= 55;
  const gasActive = state.sensors.mq7_d0 >= 1 || state.sensors.mq2_d0 >= 1;
  const items = [
    { name: 'OPTICAL FLAME · GPIO 26 (PIN 37)', key: 'fire_d0', value: state.sensors.fire_d0, unit: 'INPUT', ok: state.sensors.fire_d0 < 1 },
    { name: 'CARBON MONOXIDE · GPIO 16 (PIN 36)', key: 'mq7_d0', value: state.sensors.mq7_d0, unit: 'INPUT', ok: state.sensors.mq7_d0 < 1 },
    { name: 'FLAMMABLE GAS · GPIO 5 (PIN 29)', key: 'mq2_d0', value: state.sensors.mq2_d0, unit: 'INPUT', ok: state.sensors.mq2_d0 < 1 },
    { name: 'PIR EXIT MOTION · GPIO 4 (PIN 7)', key: 'pir_motion', value: state.sensors.pir_motion, unit: 'INPUT', ok: state.sensors.pir_motion < 1 },
    { name: 'FIRE ALARM ACTUATOR · GPIO 20 (PIN 38)', key: 'fire_actuator', value: fireActive ? 1 : 0, unit: 'OUT-GND', ok: !fireActive },
    { name: 'GAS ALARM ACTUATOR · GPIO 21 (PIN 40)', key: 'gas_actuator', value: gasActive ? 1 : 0, unit: 'OUT-GND', ok: !gasActive },
    { name: 'MASTER BUZZER · GPIO 24 (PIN 18)', key: 'buzzer_actuator', value: (fireActive || gasActive) ? 1 : 0, unit: 'OUT-GND', ok: !(fireActive || gasActive) },
  ];
  return (
    <section className="panel health-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-marker" /> FIELD DEVICES &amp; HARDWARE ACTUATORS</div>
          <h2 className="panel-title">Sensor &amp; I/O Health</h2>
        </div>
        <span className="health-count"><b>07</b> / 07 ASSIGNED</span>
      </div>
      <div className="health-list">
        {items.map((item) => (
          <div className="health-row" key={item.key} data-testid={`health-${item.key}`}>
            <div className={!telemetryAvailable ? 'health-indicator offline' : item.ok ? 'health-indicator' : 'health-indicator warning'}><Check size={11} /></div>
            <div className="health-copy">
              <b>{item.name}</b>
              <span>
                {!telemetryAvailable ? 'Waiting for telemetry' :
                  item.key === 'pir_motion' ? (item.value ? 'Personnel motion detected' : 'Clearance nominal') :
                  item.key === 'fire_d0' ? (item.ok ? 'Optical flame clear' : 'Infrared flame detected!') :
                  item.key === 'mq7_d0' ? (item.ok ? 'CO gas safe' : 'Toxic CO hazard!') :
                  item.key === 'mq2_d0' ? (item.ok ? 'Flammable gas safe' : 'Combustible gas leak detected!') :
                  item.key === 'fire_actuator' ? (item.ok ? 'Standby (3.3V)' : 'TRIGGERED (GND Active Low)') :
                  item.key === 'gas_actuator' ? (item.ok ? 'Standby (3.3V)' : 'TRIGGERED (GND Active Low)') :
                  (item.ok ? 'Standby (3.3V)' : 'ALARM SOUNDING (GND Active Low)')}
              </span>
            </div>
            <div className="health-value">
              <strong>
                {!telemetryAvailable ? 'NO DATA' :
                  item.ok ? (item.unit === 'INPUT' ? 'NORMAL' : 'STANDBY') :
                  (item.unit === 'INPUT' ? 'HAZARD' : 'GND ACT')}
              </strong>
              <span>{item.unit}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="health-footnote">All actuator outputs switch to Ground (Active-Low) when triggered. Compatible with relay modules &amp; active-low logic.</div>
    </section>
  );
}

function AuditList({ events, onRefresh, refreshing }: { events: SafetyEvent[]; onRefresh: () => void; refreshing: boolean }) {
  return (
    <section className="panel audit-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-marker marker-teal" /> TRACE / LOCAL + BROKER</div>
          <h2 className="panel-title">Audit events</h2>
        </div>
        <button type="button" className={`icon-button ${refreshing ? 'is-refreshing' : ''}`} aria-label="Refresh audit events" onClick={onRefresh} data-testid="button-refresh-audit">
          <RefreshCw size={15} />
        </button>
      </div>
      <div className="audit-list">
        {events.length === 0 ? (
          <div className="audit-empty"><Circle size={15} /> No audit events in this window.</div>
        ) : events.slice(0, 7).map((event) => (
          <article className="audit-row" key={event.id} data-testid={`audit-event-${event.id}`}>
            <div className={`event-mark event-${event.severity}`}><span /></div>
            <div className="event-main">
              <div className="event-header"><span className={`event-severity severity-${event.severity}`}>{event.severity}</span><span className="event-source">{event.source}</span></div>
              <p>{event.message}</p>
            </div>
            <time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString('en-GB', { hour12: false })}</time>
          </article>
        ))}
      </div>
      <div className="audit-footer"><span>RETENTION · CURRENT SESSION</span><ChevronRight size={14} /></div>
    </section>
  );
}

export default function Dashboard() {
  const queryClient = useQueryClient();
  // WEBSITE LOCKED BY DEFAULT: Every page load or refresh starts locked until RFID tap or PIN entry
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'sprinklers' | 'thermal' | 'audit'>('overview');
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [displaySize, setDisplaySize] = useState<DisplaySize>(4);
  const [now, setNow] = useState(new Date());
  const [demoTick, setDemoTick] = useState(0);
  const [socketConnected, setSocketConnected] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [localEvents, setLocalEvents] = useState<SafetyEvent[]>([]);
  const timeoutRef = useRef<number | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const stateQuery = useGetSafetyState({ query: { queryKey: getGetSafetyStateQueryKey(), refetchInterval: 1500, retry: 2 } });
  const eventsQuery = useGetSafetyEvents({ query: { queryKey: getGetSafetyEventsQueryKey(), refetchInterval: 5000, retry: 2 } });
  const demoMode = !stateQuery.data?.mqttUrlConfigured;
  const state = demoMode ? makeDemoState(demoTick) : stateQuery.data ?? makeDemoState(demoTick);
  const telemetryAvailable = demoMode || Boolean(stateQuery.data?.lastUpdated);
  const hotIndex = useMemo(() => state.thermal.matrix_24x32.reduce(
    (best, value, index, matrix) => value > matrix[best] ? index : best,
    0,
  ), [state.thermal.matrix_24x32]);
  const hotX = hotIndex % 32;
  const hotY = Math.floor(hotIndex / 32);
  const fireActive = state.sensors.fire_d0 >= 1;
  const hazardActive = fireActive || state.sensors.mq7_d0 >= 1 || state.sensors.mq2_d0 >= 1 || state.thermal.max_temp >= 55;
  const overallStatus = fireActive
    ? 'ACTIVE FIRE'
    : hazardActive
      ? 'HAZARD WARNING'
      : !telemetryAvailable
        ? 'WAITING FOR DATA'
        : demoMode
          ? 'SIMULATION'
          : state.mqttConnected
            ? 'NORMAL'
            : 'DEGRADED';
  const events = useMemo(() => {
    const apiEvents = eventsQuery.data ?? [];
    const baseEvents = demoMode ? [...apiEvents, ...demoEvents] : apiEvents;
    return [...localEvents, ...baseEvents]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [demoMode, eventsQuery.data, localEvents]);

  const addLocalEvent = useCallback((severity: SafetyEvent['severity'], source: string, message: string) => {
    const event: SafetyEvent = { id: `${Date.now()}-${Math.random().toString(16).slice(2, 7)}`, timestamp: new Date().toISOString(), severity, source, message };
    setLocalEvents((current) => [event, ...current].slice(0, 8));
  }, []);

  const unlock = useCallback((source = 'LOCAL-READER') => {
    setIsUnlocked(true);
    setUnlockOpen(false);
    try {
      localStorage.setItem('ember_watch_unlocked', 'true');
    } catch {}
    addLocalEvent('normal', 'AUTH-GATE', `Monitor view unlocked via ${source}`);
  }, [addLocalEvent]);

  const lock = useCallback(() => {
    setIsUnlocked(false);
    setUnlockOpen(false);
    try {
      localStorage.removeItem('ember_watch_unlocked');
    } catch {}
    addLocalEvent('normal', 'AUTH-GATE', 'Monitor view locked by operator');
  }, [addLocalEvent]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(new Date());
      setDemoTick((current) => current + 1);
    }, 1800);
    return () => window.clearInterval(interval);
  }, []);

  // Session stays unlocked until operator clicks 'Lock dashboard' or taps another card


  useEffect(() => {
    const socket = io(window.location.origin, {
      path: '/api/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;
    socket.on('connect', () => setSocketConnected(true));
    socket.on('disconnect', () => setSocketConnected(false));
    socket.on('connect_error', () => setSocketConnected(false));
    const updateState = (incomingState: SafetyState) => {
      queryClient.setQueryData<SafetyState>(getGetSafetyStateQueryKey(), incomingState);
    };
    socket.on('safety:state', updateState);
    socket.on('safety:status', updateState);
    socket.on('safety:events', (incomingEvents: SafetyEvent[]) => {
      queryClient.setQueryData<SafetyEvent[]>(getGetSafetyEventsQueryKey(), incomingEvents);
    });
    socket.on('safety:event', (liveEvent: SafetyEvent) => {
      setLocalEvents((current) => [liveEvent, ...current.filter((item) => item.id !== liveEvent.id)].slice(0, 8));
    });
    socket.on('safety:rfid', (event: LiveRfidPayload) => {
      if (event.authorized) {
        unlock('PHYSICAL RFID CARD');
      } else {
        addLocalEvent('warning', 'RFID', `Unregistered RFID card ${event.uid?.slice(-4) ?? ''} rejected`);
      }
    });
    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [addLocalEvent, queryClient, unlock]);

  useEffect(() => {
    if (!audioEnabled || !fireActive) {
      return;
    }
    const audioContext = new window.AudioContext();
    let disposed = false;
    const playAlert = () => {
      if (disposed || audioContext.state !== 'running') {
        return;
      }
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = 'square';
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.035, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.22);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.22);
    };
    void audioContext.resume().then(playAlert);
    const interval = window.setInterval(playAlert, 1400);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      void audioContext.close();
    };
  }, [audioEnabled, fireActive]);

  const handleUnlock = useCallback(() => unlock('LOCAL DEMO READER'), [unlock]);
  const refreshEvents = useCallback(() => {
    void eventsQuery.refetch();
  }, [eventsQuery]);
  return (
    <main className="dashboard-shell">
      <aside className="side-rail">
        <div className="brand-lockup">
          <div className="brand-mark"><Flame size={19} /></div>
          <div className="brand-name">EMBER<span>WATCH</span></div>
        </div>
        <div className="rail-rule" />
        <div className="rail-section-label">FACILITY</div>
        <div className="facility-select">
          <div className="facility-symbol"><span>WH</span></div>
          <div><b>North logistics</b><span>WAREHOUSE 07</span></div>
          <ChevronRight size={14} />
        </div>
        <div className="rail-nav-label">MONITORING</div>
        <button
          type="button"
          onClick={() => setActiveTab('overview')}
          className={`rail-nav-item ${activeTab === 'overview' ? 'active' : ''}`}
        >
          <Activity size={16} /><span>Live Overview</span>{activeTab === 'overview' && <i />}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('sprinklers')}
          className={`rail-nav-item ${activeTab === 'sprinklers' ? 'active' : ''}`}
        >
          <Waves size={16} /><span>Sprinkler Grid</span>{activeTab === 'sprinklers' && <i />}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('thermal')}
          className={`rail-nav-item ${activeTab === 'thermal' ? 'active' : ''}`}
        >
          <Gauge size={16} /><span>Thermal Vision</span>{activeTab === 'thermal' && <i />}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('audit')}
          className={`rail-nav-item ${activeTab === 'audit' ? 'active' : ''}`}
        >
          <ShieldCheck size={16} /><span>Audit &amp; Access</span>{activeTab === 'audit' && <i />}
        </button>
        <div className="rail-bottom">
          <div className="rail-bottom-line" />
          <div className="operator-badge">
            <div className="operator-avatar">OP</div>
            <div className="operator-copy"><b>Control room</b><span>{isUnlocked ? 'SESSION ACTIVE' : 'SESSION LOCKED'}</span></div>
            <span className={isUnlocked ? 'operator-state unlocked' : 'operator-state'} />
          </div>
          <div className="rail-version mono-font">EMBER / MONITOR 2.4.1</div>
        </div>
      </aside>

      <div className="dashboard-main">
        <header className="topbar">
          <div className="breadcrumb">
            <span>FACILITY SYSTEMS</span>
            <ChevronRight size={13} />
            <b>{activeTab.toUpperCase()} MONITOR</b>
          </div>
          <div className="topbar-right">
            {demoMode && <div className="demo-badge" data-testid="status-demo-mode"><span /> DEMO TELEMETRY</div>}
            <div className={`connection-badge ${socketConnected ? 'connected' : ''}`}><i />{socketConnected ? 'SOCKET LIVE' : 'SOCKET OFFLINE'}</div>
            <div className="topbar-clock"><span>LOCAL TIME</span><b>{formatClock(now)}</b></div>
            {isUnlocked ? (
              <button type="button" className="button-lock" onClick={lock} data-testid="button-lock-dashboard"><LockKeyhole size={14} /> Lock dashboard</button>
            ) : (
              <button type="button" className="button-unlock" onClick={() => setUnlockOpen(true)} data-testid="button-open-unlock"><LockKeyhole size={14} /> Unlock view</button>
            )}
          </div>
        </header>

        <div className="page-content">
          <div className="page-title-row page-enter">
            <div>
              <div className="title-kicker"><span className={`system-status-dot ${overallStatus === 'NORMAL' || overallStatus === 'SIMULATION' ? '' : overallStatus === 'ACTIVE FIRE' ? 'fire-active' : 'attention'}`} /> NORTH LOGISTICS · BUILDING 07 <span className="kicker-divider">/</span> FIRE &amp; ENVIRONMENTAL</div>
              <h1 className="display-font">Safety <span>overview</span><sup>07</sup></h1>
              <p className="page-subtitle">Environmental conditions &amp; system telemetry <span className="subtitle-divider">·</span> Last update {formatAge(state.lastUpdated)}</p>
            </div>
            <div className={`overall-state ${fireActive ? 'state-fire-active' : overallStatus === 'NORMAL' || overallStatus === 'SIMULATION' ? '' : 'state-attention'}`}>
              <div className="overall-state-icon">{fireActive ? <Flame size={17} /> : overallStatus === 'NORMAL' || overallStatus === 'SIMULATION' ? <Check size={17} /> : <AlertTriangle size={17} />}</div>
              <div><span>SYSTEM STATUS</span><b>{overallStatus}</b></div>
              <div className="overall-state-time mono-font">{formatClock(now)}</div>
              <button
                type="button"
                className={`audio-alert-toggle ${audioEnabled ? 'audio-enabled' : ''}`}
                aria-label={audioEnabled ? 'Disable fire audio alert' : 'Enable fire audio alert'}
                aria-pressed={audioEnabled}
                onClick={() => setAudioEnabled((enabled) => !enabled)}
                data-testid="button-audio-alert"
              >
                {audioEnabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
              </button>
            </div>
          </div>

          <section className="system-strip page-enter stagger-1" aria-label="System connection status">
            <div className="system-strip-item">
              <div className={`strip-icon ${state.mqttConnected ? 'strip-ok' : 'strip-alert'}`}><Wifi size={15} /></div>
              <div><span>MQTT BROKER</span><b>{state.mqttConnected ? 'Connected' : 'Disconnected'}</b></div>
              <i className={state.mqttConnected ? 'strip-indicator good' : 'strip-indicator bad'} />
            </div>
            <div className="strip-divider" />
            <div className="system-strip-item">
              <div className={`strip-icon ${state.mqttUrlConfigured ? 'strip-ok' : 'strip-alert'}`}><Cloud size={15} /></div>
              <div><span>BROKER CONFIG</span><b>{state.mqttUrlConfigured ? 'Endpoint configured' : 'Endpoint missing'}</b></div>
              <i className={state.mqttUrlConfigured ? 'strip-indicator good' : 'strip-indicator bad'} />
            </div>
            <div className="strip-divider" />
            <div className="system-strip-item">
              <div className={`strip-icon ${isUnlocked ? 'strip-ok' : 'strip-locked'}`}><LockKeyhole size={15} /></div>
              <div><span>VIEW AUTH</span><b>{isUnlocked ? 'Authenticated session' : 'Locked · read access gated'}</b></div>
              <i className={isUnlocked ? 'strip-indicator good' : 'strip-indicator neutral'} />
            </div>
            <div className="strip-side-note"><Radio size={13} /> {socketConnected ? 'REAL-TIME LINK' : 'RECONNECTING'} <span className="pulse-dot" /></div>
          </section>

          {!isUnlocked ? (
            <div className="my-8 p-10 bg-zinc-950/90 border border-zinc-800 rounded-2xl shadow-2xl backdrop-blur-md max-w-3xl mx-auto text-center page-enter">
              <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 shadow-inner">
                <ShieldCheck size={42} strokeWidth={1.8} className="animate-pulse" />
              </div>
              <div className="text-xs font-mono tracking-widest text-amber-500 uppercase font-semibold mb-2">
                RESTRICTED WAREHOUSE CONSOLE · ACCESS CONTROL GATE
              </div>
              <h2 className="text-2xl font-bold text-zinc-100 mb-3 tracking-tight">
                System Telemetry Locked
              </h2>
              <p className="text-zinc-400 text-sm max-w-lg mx-auto mb-8 leading-relaxed">
                Live sensor streams, sprinkler zones, and 768-pixel thermal infrared surveillance are restricted. Tap an authorized RFID badge on the BeagleY-AI terminal or enter your security UID below to unlock.
              </p>

              <div className="p-6 bg-zinc-900/60 border border-zinc-800/80 rounded-xl mb-6 flex flex-col items-center justify-center">
                <div className="flex items-center gap-3 text-zinc-300 font-mono text-sm mb-2">
                  <Radio size={16} className="text-emerald-400 animate-ping" />
                  <span>Awaiting RFID Badge Tap on BeagleY...</span>
                </div>
                <span className="text-xs text-zinc-500">
                  Approved Badges: 5281A25C &bull; 5299945C
                </span>
              </div>

              <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
                <button
                  type="button"
                  onClick={() => setUnlockOpen(true)}
                  className="w-full sm:w-auto px-6 py-3 bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold rounded-lg text-sm transition-all shadow-lg shadow-amber-500/20 flex items-center justify-center gap-2 cursor-pointer"
                >
                  <LockKeyhole size={16} /> Enter Badge UID Manually
                </button>
              </div>
            </div>
          ) : (
            <>
              {activeTab === 'overview' && (
                <>
                  <div className="section-heading">
                    <div><span>01</span><h2>Environmental sensors</h2></div>
                    <p>FIELD READINGS <i /> LIVE GPIO TELEMETRY</p>
                  </div>
                  <section className="sensor-grid page-enter stagger-2">
                    <StatCard label="Optical flame sensor · GPIO 26" tag="FIRE · D0" value={!telemetryAvailable ? 'NO DATA' : fireActive ? 'FLAME' : 'NORMAL'} status={!telemetryAvailable ? 'offline' : fireActive ? 'critical' : 'normal'} statusText={!telemetryAvailable ? 'NO SIGNAL' : fireActive ? 'FLAME DETECTED' : 'NORMAL'} icon={Flame} detail="Digital D0 · GPIO 26" />
                    <StatCard label="MQ-7 carbon monoxide · GPIO 16" tag="CO · MQ-7" value={!telemetryAvailable ? 'NO DATA' : state.sensors.mq7_d0 >= 1 ? 'TOXIC CO' : 'SAFE'} status={!telemetryAvailable ? 'offline' : state.sensors.mq7_d0 >= 1 ? 'critical' : 'normal'} statusText={!telemetryAvailable ? 'NO SIGNAL' : state.sensors.mq7_d0 >= 1 ? 'TOXIC CO HAZARD' : 'SAFE'} icon={Wind} detail="Digital D0 · GPIO 16" />
                    <StatCard label="MQ-2 flammable gas · GPIO 20" tag="GAS · MQ-2" value={!telemetryAvailable ? 'NO DATA' : state.sensors.mq2_d0 >= 1 ? 'GAS LEAK' : 'NORMAL'} status={!telemetryAvailable ? 'offline' : state.sensors.mq2_d0 >= 1 ? 'warning' : 'normal'} statusText={!telemetryAvailable ? 'NO SIGNAL' : state.sensors.mq2_d0 >= 1 ? 'GAS LEAK DETECTED' : 'NORMAL'} icon={Waves} detail="Digital D0 · GPIO 20" />
                    <StatCard label="PIR exit motion · GPIO 4" tag="PIR · EXIT" value={!telemetryAvailable ? 'NO DATA' : state.sensors.pir_motion >= 1 ? 'MOTION' : 'CLEAR'} status={!telemetryAvailable ? 'offline' : state.sensors.pir_motion >= 1 ? 'warning' : 'normal'} statusText={!telemetryAvailable ? 'NO SIGNAL' : state.sensors.pir_motion >= 1 ? 'PERSONNEL DETECTED' : 'CLEARANCE'} icon={Zap} detail="Pin 7 / GPIO 4" />
                  </section>

                  <div className="section-heading section-heading-lower mt-6">
                    <div><span>02</span><h2>Thermal infrared imaging</h2></div>
                    <p>CONTINUOUS MLX90640 THERMAL STREAM <i /> LIVE HEATMAP</p>
                  </div>
                  <div className="content-grid">
                    {telemetryAvailable ? (
                      <ThermalMap
                        matrix={state.thermal.matrix_24x32}
                        maxTemp={state.thermal.max_temp}
                        avgTemp={state.thermal.avg_temp}
                        displaySize={displaySize}
                        onDisplaySizeChange={setDisplaySize}
                      />
                    ) : (
                      <section className="panel thermal-panel masked-panel" data-testid="status-thermal-waiting">
                        <div className="panel-heading"><div><div className="eyebrow"><span className="eyebrow-marker" /> THERMAL FIELD / ZONE A</div><h2 className="panel-title">Overhead temperature map</h2></div><span className="quiet-label">NO SIGNAL</span></div>
                        <div className="masked-map"><Thermometer size={27} /><b>Waiting for first telemetry packet</b><span>Temperature values are unknown until valid sensor data arrives.</span></div>
                      </section>
                    )}
                    <SensorHealth state={state} telemetryAvailable={telemetryAvailable} />
                  </div>

                  <div className="content-grid lower-grid mt-6">
                    <SprinklerStatus
                      displaySize={displaySize}
                      onDisplaySizeChange={setDisplaySize}
                      telemetryAvailable={telemetryAvailable}
                      maxTemp={state.thermal.max_temp}
                      hotX={hotX}
                      hotY={hotY}
                    />
                    <AuditList events={events} onRefresh={refreshEvents} refreshing={eventsQuery.isFetching} />
                  </div>
                </>
              )}

              {activeTab === 'sprinklers' && (
                <>
                  <div className="section-heading">
                    <div><span>ZONE GRID</span><h2>Automated Sprinkler Suppression Grid</h2></div>
                    <p>SUPPRESSION VALVES <i /> THERMAL INFERENCE SYSTEM</p>
                  </div>
                  <div className="content-grid">
                    <SprinklerStatus
                      displaySize={displaySize}
                      onDisplaySizeChange={setDisplaySize}
                      telemetryAvailable={telemetryAvailable}
                      maxTemp={state.thermal.max_temp}
                      hotX={hotX}
                      hotY={hotY}
                    />
                    <SensorHealth state={state} telemetryAvailable={telemetryAvailable} />
                  </div>
                  <div className="mt-6">
                    <AuditList events={events} onRefresh={refreshEvents} refreshing={eventsQuery.isFetching} />
                  </div>
                </>
              )}

              {activeTab === 'thermal' && (
                <>
                  <div className="section-heading">
                    <div><span>INFRARED</span><h2>High-Resolution Thermal Vision Monitoring</h2></div>
                    <p>MLX90640 ARRAY <i /> 768-PIXEL THERMAL INTERPOLATION</p>
                  </div>
                  <div className="content-grid">
                    <ThermalMap
                      matrix={state.thermal.matrix_24x32}
                      maxTemp={state.thermal.max_temp}
                      avgTemp={state.thermal.avg_temp}
                      displaySize={displaySize}
                      onDisplaySizeChange={setDisplaySize}
                    />
                    <SensorHealth state={state} telemetryAvailable={telemetryAvailable} />
                  </div>
                </>
              )}

              {activeTab === 'audit' && (
                <>
                  <div className="section-heading">
                    <div><span>SECURITY</span><h2>RFID Access Logs &amp; Audit Trace</h2></div>
                    <p>EVENT TRAIL <i /> BADGE SCAN LOGS</p>
                  </div>
                  <div className="content-grid">
                    <AuditList events={events} onRefresh={refreshEvents} refreshing={eventsQuery.isFetching} />
                    <SensorHealth state={state} telemetryAvailable={telemetryAvailable} />
                  </div>
                </>
              )}
            </>
          )}
          <footer className="page-footer">
            <div><span className="footer-mark">EW</span><span>EMBERWATCH CONTROL ROOM</span></div>
            <p>Monitoring and recorded telemetry only. This interface does not operate or replace certified life-safety systems.</p>
            <div className="footer-system"><Signal size={13} /> {demoMode ? 'SIMULATION ACTIVE' : 'LIVE DATA'} <span>·</span> {formatClock(now)}</div>
          </footer>
          {stateQuery.isLoading && <div className="query-status"><RefreshCw size={13} /> Connecting to telemetry endpoint</div>}
        </div>
      </div>
      {unlockOpen && <UnlockModal onClose={() => setUnlockOpen(false)} onUnlock={handleUnlock} />}
    </main>
  );
}
