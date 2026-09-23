# ESPHome

Dashboard for creating, configuring and flashing firmware for ESP8266/ESP32
and other microcontrollers from YAML. Runs as an OCI-image LXC container
(`ghcr.io/esphome/esphome`). The web dashboard listens on port **6052**.

## HTTPS

ESPHome's standalone dashboard has **no native HTTPS support** — the
`esphome dashboard` command only exposes plain HTTP on `--port` (default 6052).
This application therefore serves the dashboard over **HTTP only**. For
TLS, put a reverse proxy in front of it, or run it on a trusted LAN segment.

## Flashing devices over USB (serial)

To flash a device for the first time over USB, map its serial port into the
container with the **Map Serial Device** step:

- Set **USB Serial Port** (`host_device_path`) to a stable
  `/dev/serial/by-id/...` path.
- The device appears inside the container at **Container Device Path**
  (default `/dev/ttyUSB0`; many ESP boards enumerate as `/dev/ttyACM0`),
  selectable in the dashboard's flash dialog.

If you leave the serial port empty, the step is skipped and you can still
manage devices over-the-air (OTA).

## Storage

The `config` volume (mounted at `/config`, default 4 GB) holds your device
YAML **and** the PlatformIO build cache / downloaded toolchains, which grow
over time — size it generously.
