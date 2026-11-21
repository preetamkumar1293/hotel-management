# Hotel Stock

Stock, tracked assets, room audits, Airbnb/PMS bookings and expenses (with receipt photos) for a small hotel.

## Run locally
    npm install
    npm start            # http://localhost:3000
    npm run seed         # optional: demo rooms/items/assets (fresh database only)

First start creates an admin: `admin@hotel.local` / `admin12345` (or set `ADMIN_EMAIL` / `ADMIN_PASSWORD`).
**Change the password immediately** (More → Change my password).

## Settings (environment variables)
| Variable | Purpose |
|---|---|
| `PORT` | Port (Hostinger sets this automatically) |
| `DATA_DIR` | Where the database and receipt photos are stored. **Put this OUTSIDE the app folder** so redeploys never wipe it |
| `TZ` | Time zone, default `Asia/Kolkata` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First-run admin account |
| `JWT_SECRET` | Optional fixed login-signing secret |

## Deploy on Hostinger Business Web Hosting (Node.js web app)
1. Make the zip (no `node_modules`, `.git` or `data`): `zip -r hotel-stock.zip . -x "node_modules/*" -x ".git/*" -x "data/*"`
2. hPanel → Websites → Add Website → **Node.js Web App** → **Upload your website files** → upload the zip.
3. Build settings: Node.js **22.x**, build command `npm install`, start command `npm start`, entry `server.js`.
4. Environment variables (add at this step, or later under *Environment variables* in the app's dashboard):
       ADMIN_EMAIL=you@yourhotel.com
       ADMIN_PASSWORD=<a long password>
       DATA_DIR=/home/<your-hostinger-username>/hotel-data
       TZ=Asia/Kolkata
   Create the `hotel-data` folder first (File Manager → your home folder, NOT inside `domains/`). See `hostinger.env.example`.
5. Deploy, open your domain (HTTPS is automatic, which camera scanning needs), sign in, then change the password.
6. **Persistence test before real use:** add a test expense with a photo → Settings & redeploy → *Use previous files* → redeploy → confirm it is still there.
7. Download a backup (Settings → Airbnb & PMS → Backup) weekly; also copy `hotel-data/uploads` (receipt photos).

If the build log shows `better-sqlite3` failing to install, contact Hostinger support or use the VPS route below.

## Deploy on a Hostinger VPS (most reliable)
    # Ubuntu, as root
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs build-essential caddy
    mkdir -p /opt/hotel-stock /var/lib/hotel-data && cd /opt/hotel-stock   # upload the project here
    npm ci --omit=dev
    # /etc/systemd/system/hotel-stock.service
    [Service]
    WorkingDirectory=/opt/hotel-stock
    Environment=PORT=3000 DATA_DIR=/var/lib/hotel-data ADMIN_PASSWORD=change-me
    ExecStart=/usr/bin/node server.js
    Restart=always
    [Install]
    WantedBy=multi-user.target
    systemctl enable --now hotel-stock
    # Caddy gives free HTTPS: /etc/caddy/Caddyfile →   stock.yourdomain.com { reverse_proxy localhost:3000 }
Or with Docker: `docker build -t hotel-stock . && docker run -d -p 3000:3000 -v hotel-data:/data hotel-stock`.

## Labels and scanning
- Rooms, assets and stock items each have a printable Code 128 barcode label (Print labels). Assets get tags `A00001…`, rooms use their code (`R-101`), stock items use their barcode (auto `I00001…`, or the product's own EAN).
- Scan with the phone camera (Scan tab) or a handheld/Bluetooth scanner typed into the box.

## Airbnb
Airbnb → Calendar → Availability → Export calendar → copy link → paste into the room (Settings → Rooms & places → Edit). Synced every 30 min. Airbnb calendars give dates only (no guest names) and mark blocked dates.

## PMS
POST JSON to `/api/pms/event` with header `x-api-key` (shown in Settings → Airbnb & PMS). Events: `booking`, `checkin`, `checkout`, `cancel`, `room_status`. Since I don't know which PMS you use, this is a generic webhook — it needs a small mapping on the PMS/channel-manager side (or Zapier/Make).

## Roles
admin: everything · manager: stock, assets, approvals, settings · accounts: expenses & purchasing · housekeeping: scan, use stock, audit, submit own expenses.

## Not included yet
Offline mode (needs signal), RFID, direct two-way PMS API for a specific vendor, bill payment/accounting export beyond CSV.
