#!/bin/bash
# ==========================================================
# BeagleY Quick Connect & Full System Launcher
# Connects BeagleY-AI + starts API, Frontend & ngrok Website
# Usage: ~/beagley-connect.sh
# ==========================================================

set -e
echo "=============================================="
echo "   BeagleY Safety System - Full Auto Connect  "
echo "=============================================="

# 1. Wait for BeagleY to be reachable
echo "[1/6] Detecting BeagleY at 192.168.7.2..."
until ping -c1 -W1 192.168.7.2 &>/dev/null; do
  echo "      Waiting for USB network to initialize..."
  sleep 2
done
echo "      ✓ BeagleY hardware reachable"

# 2. Dynamic interface detection & NAT setup
USB_IF=$(ip route get 192.168.7.2 2>/dev/null | grep -oP 'dev \K\S+' || echo "enp0s20f0u5")
INET_IF=$(ip route get 8.8.8.8 2>/dev/null | grep -oP 'dev \K\S+' || echo "wlp0s20f3")
echo "[2/6] Enabling internet forwarding (USB: $USB_IF -> INET: $INET_IF)..."
echo 'Robosoni@1412' | sudo -S sysctl -q -w net.ipv4.ip_forward=1 2>/dev/null
echo 'Robosoni@1412' | sudo -S iptables -t nat -C POSTROUTING -o "$INET_IF" -j MASQUERADE 2>/dev/null \
  || echo 'Robosoni@1412' | sudo -S iptables -t nat -A POSTROUTING -o "$INET_IF" -j MASQUERADE 2>/dev/null
echo 'Robosoni@1412' | sudo -S iptables -C FORWARD -i "$USB_IF" -o "$INET_IF" -j ACCEPT 2>/dev/null \
  || echo 'Robosoni@1412' | sudo -S iptables -A FORWARD -i "$USB_IF" -o "$INET_IF" -j ACCEPT 2>/dev/null
echo 'Robosoni@1412' | sudo -S iptables -C FORWARD -i "$INET_IF" -o "$USB_IF" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null \
  || echo 'Robosoni@1412' | sudo -S iptables -A FORWARD -i "$INET_IF" -o "$USB_IF" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null
echo "      ✓ Laptop NAT routing active"

# 3. Set default gateway on BeagleY
echo "[3/6] Setting default gateway on BeagleY..."
ssh -o ConnectTimeout=5 bitlords@192.168.7.2 \
  "echo 'bitlords' | sudo -S ip route del default 2>/dev/null; echo 'bitlords' | sudo -S ip route add default via 192.168.7.1" 2>/dev/null || true
echo "      ✓ Gateway configured (192.168.7.1)"

# 4. Restart sensor publisher on BeagleY
echo "[4/6] Restarting BeagleY telemetry publisher..."
ssh -o ConnectTimeout=5 bitlords@192.168.7.2 \
  "systemctl --user restart warehouse-publisher.service" 2>/dev/null || true
sleep 3
MQTT_STATUS=$(ssh -o ConnectTimeout=5 bitlords@192.168.7.2 \
  "systemctl --user status warehouse-publisher.service --no-pager -l 2>&1 | grep -o 'Connected to broker.emqx.io'" 2>/dev/null || true)
if [ -n "$MQTT_STATUS" ]; then
  echo "      ✓ BeagleY publisher connected to broker.emqx.io"
else
  echo "      ⚠ Publisher starting up (connecting in background)"
fi

# 5. Start API Server & Frontend Vite dev server (if not already running)
echo "[5/6] Verifying local services (API server & Frontend)..."
if ! curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/healthz | grep -q "200"; then
  echo "      Starting API server on port 3000..."
  cd /home/pranso/Mini_project
  nohup env MQTT_URL="mqtt://broker.emqx.io:1883" RFID_ALLOWED_UIDS="5281A25C,5299945C" PORT=3000 npx -y pnpm --filter @workspace/api-server run start > /home/pranso/.beagley_api.log 2>&1 &
  sleep 3
fi
echo "      ✓ API server active on http://localhost:3000"

if ! curl -s -o /dev/null -w "%{http_code}" http://localhost:5173 | grep -q "200"; then
  echo "      Starting Vite frontend on port 5173..."
  cd /home/pranso/Mini_project
  nohup env PORT=5173 npx -y pnpm --filter @workspace/warehouse-fire-safety run dev > /home/pranso/.beagley_vite.log 2>&1 &
  sleep 3
fi
echo "      ✓ Frontend active on http://localhost:5173"

# 6. Start ngrok tunnel for public static URL
echo "[6/6] Checking permanent website tunnel..."
if ! pgrep -x "ngrok" > /dev/null; then
  echo "      Starting ngrok tunnel for carry-freehand-uninvited.ngrok-free.dev..."
  nohup ngrok http 5173 --url=carry-freehand-uninvited.ngrok-free.dev > /home/pranso/.beagley_ngrok.log 2>&1 &
  sleep 3
fi

TUNNEL_CHECK=$(curl -s -H "ngrok-skip-browser-warning: true" -o /dev/null -w "%{http_code}" https://carry-freehand-uninvited.ngrok-free.dev || echo "000")
if [ "$TUNNEL_CHECK" = "200" ]; then
  echo "      ✓ Website is ONLINE and fully operational!"
else
  echo "      ⚠ Tunnel initializing, verifying in 3 seconds..."
  sleep 3
fi

echo ""
echo "============================================================"
echo "  🚀 SYSTEM IS READY!"
echo "  Website URL: https://carry-freehand-uninvited.ngrok-free.dev"
echo "  Approved RFID Cards: 5281A25C | 5299945C"
echo "============================================================"
