# Detailed Project Changelog & Milestones


This log records the complete development lifecycle, hardware bring-up, debugging findings, and architectural decisions made throughout the project.

---

### [Phase 5] —  Mirrored Sprinkler Bus & Active-Low Actuators
- **Mirrored 4×4 Zone Realignment**:
  - Re-indexed the sprinkler matrix from traditional row-major sequence into the mirrored hardware format:
    $$\text{Row 0: [04, 03, 02, 01] } \quad \text{Row 1: [08, 07, 06, 05] } \quad \text{Row 2: [12, 11, 10, 09] } \quad \text{Row 3: [16, 15, 14, 13]}$$
  - Implemented spatial mapping equation: $\text{Zone} = 4r + 4 - c$, $\text{Channel} = \text{Zone} - 1$.
- **4-Bit Active-Low GPIO Sprinkler Bus**:
  - Claimed 4 high-speed GPIO lines on BeagleY-AI `gpiochip3`:
    - Bit 0 (LSB): Pin 31 (GPIO6, line 17)
    - Bit 1: Pin 32 (GPIO12, line 16)
    - Bit 2: Pin 33 (GPIO13, line 18)
    - Bit 3 (MSB): Pin 35 (GPIO19, line 12)
  - Configured active-low output driver: bit `1` asserts to Ground (0V), while bit `0` holds 3.3V.
- **Hazard Actuator Outputs**:
  - Added Pin 38 (`gpiochip3 line 10`) for Fire Alarm / Extinguisher solenoid.
  - Added Pin 40 (`gpiochip3 line 9`) for Gas Hazard / Exhaust Fan actuation.
  - Added Pin 18 (`gpiochip1 line 10`) for Master Warning Buzzer.
- **MQ2 Flammable Gas Sensor Integration**:
  - Added Pin 29 (`gpiochip3 line 15`) for combustible gas and smoke digital input.
- **Automated Service Orchestrator (`beagley-connect.sh`)**:
  - Enhanced reconnect script to dynamically detect changing USB interfaces, configure iptables NAT, set BeagleY gateway routes, and launch background API/Vite/ngrok daemons.

---

### [Phase 4] —  Cloud MQTT Bridge & Permanent Static URL
- **Cloud MQTT Migration (`broker.emqx.io`)**:
  - Diagnosed local network port-1883 packet drops on `test.mosquitto.org` and migrated the pipeline to `broker.emqx.io:1883`.
  - Added background worker threading to make edge publisher connection non-blocking.
- **Permanent ngrok Public Domain**:
  - Configured permanent static domain `https://carry-freehand-uninvited.ngrok-free.dev`.
- **UI Industrial Refresh**:
  - Redesigned visual palette with slate-blue industrial theme (`#0b1118` / `#141b24`).
  - Added multi-tab navigation: Live Overview, Sprinkler Grid, Thermal Vision, and Audit Trail.
  - Integrated bilinear Ironbow false-color colormap with auto-ranging $\Delta T \ge 2.5^\circ\text{C}$.
- **Access Control & RFID Lock**:
  - Implemented default locked dashboard state on load/refresh.
  - Whitelisted physical RFID tags `5281A25C` and `5299945C` with real-time Socket.IO unlock notifications.

---

### [Phase 3] —  Native Bitbang RC522 SPI Driver
- **Custom Software SPI Implementation**:
  - Built `rc522_driver.py` using direct `gpiod` line toggling across AM67A split GPIO chips:
    - CS on Pin 11 (`gpiochip3 line 8`)
    - SCK on Pin 13 (`gpiochip2 line 33`)
    - MOSI on Pin 15 (`gpiochip2 line 41`)
    - MISO on Pin 16 (`gpiochip1 line 7`)
    - RST on Pin 22 (`gpiochip2 line 42`)
  - Tuned register soft-reset sequence and antenna gain to maximum (48dB) for reliable card detection.

---

### [Phase 2] —  MLX90640 Thermal Sensor Integration
- **I2C-1 Bus Adapter**:
  - Created SMBus I2C bridge on `/dev/i2c-1` (device address `0x33`).
  - Implemented 768-pixel thermal frame buffer with algorithmic smoothing and out-of-range sensor filtering.
- **GPIO Digital Sensors**:
  - Verified PIR motion sensor input on Pin 7 (`gpiochip2 line 38`).
  - Verified Optical Flame detector input on Pin 37 (`gpiochip2 line 36`).
  - Verified MQ7 Carbon Monoxide detector input on Pin 36 (`gpiochip3 line 7`).

---

### [Phase 1] —  Monorepo Architecture & Real-Time Server
- **Monorepo Foundation**:
  - Set up pnpm workspaces with React 19 frontend, Tailwind CSS, Express 5 API server, and TypeScript schemas.
  - Implemented Socket.IO bidirectional event bus for instant state streaming.
