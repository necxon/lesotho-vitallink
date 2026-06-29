#!/usr/bin/env python3
"""Generate a high-level architecture diagram PNG for the Lesotho Health System Sandbox."""

from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1400, 900
BG = (250, 250, 252)
img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# ── colour palette ──────────────────────────────────────────────────
C_ANDROID   = (52, 168, 83)    # green
C_OPENHIM   = (66, 133, 244)   # blue
C_MEDIATOR  = (234, 67, 53)    # red
C_OPENSRP   = (251, 188, 4)    # yellow-ish (dark text)
C_OPENLMIS  = (100, 181, 246)  # light blue
C_DHIS2     = (38, 166, 154)   # teal
C_KEYCLOAK  = (171, 71, 188)   # purple
C_HAPI      = (255, 138, 101)  # orange
C_PG        = (120, 144, 156)  # grey-blue
C_WHITE     = (255, 255, 255)
C_DARK      = (30, 30, 30)
C_ARROW     = (80, 80, 80)
C_BORDER    = (200, 200, 200)

# Try to load a font; fall back to default if unavailable
def font(size):
    for name in ["arialbd.ttf", "arial.ttf", "DejaVuSans-Bold.ttf",
                 "DejaVuSans.ttf", "FreeSansBold.ttf", "FreeSans.ttf"]:
        for path in [
            "C:/Windows/Fonts/" + name,
            "/usr/share/fonts/truetype/dejavu/" + name,
            "/usr/share/fonts/truetype/freefont/" + name,
        ]:
            if os.path.exists(path):
                try:
                    return ImageFont.truetype(path, size)
                except Exception:
                    pass
    return ImageFont.load_default()

fnt_title  = font(22)
fnt_bold   = font(16)
fnt_normal = font(13)
fnt_small  = font(11)
fnt_port   = font(10)

def box(x, y, w, h, fill, label, sublabel="", port="", text_color=C_WHITE, radius=12):
    """Draw a rounded rectangle with centred label."""
    d.rounded_rectangle([x, y, x+w, y+h], radius=radius, fill=fill, outline=C_BORDER, width=2)
    cx = x + w // 2
    ty = y + h // 2 - 12
    d.text((cx, ty), label, font=fnt_bold, fill=text_color, anchor="mm")
    if sublabel:
        d.text((cx, ty + 18), sublabel, font=fnt_small, fill=text_color, anchor="mm")
    if port:
        d.text((cx, y + h - 10), port, font=fnt_port, fill=(*text_color[:3], 180), anchor="mm")

def arrow(x1, y1, x2, y2, label="", color=C_ARROW, dashed=False):
    """Draw an arrow from (x1,y1) to (x2,y2)."""
    if dashed:
        # draw dashed line
        import math
        length = math.hypot(x2-x1, y2-y1)
        steps = int(length // 10)
        for i in range(0, steps, 2):
            t0, t1 = i/steps, min((i+1)/steps, 1)
            d.line([(x1+t0*(x2-x1), y1+t0*(y2-y1)),
                    (x1+t1*(x2-x1), y1+t1*(y2-y1))], fill=color, width=2)
    else:
        d.line([(x1, y1), (x2, y2)], fill=color, width=2)
    # arrowhead
    import math
    angle = math.atan2(y2-y1, x2-x1)
    alen = 10
    for a in [angle + 2.5, angle - 2.5]:
        d.line([(x2, y2), (x2 - alen*math.cos(a), y2 - alen*math.sin(a))],
               fill=color, width=2)
    if label:
        mx, my = (x1+x2)//2, (y1+y2)//2
        d.text((mx+4, my-10), label, font=fnt_small, fill=color)

# ── layout constants ─────────────────────────────────────────────────
BW, BH = 170, 60      # standard box  width / height
SBOX_W, SBOX_H = 140, 52  # small box

# ── TITLE ────────────────────────────────────────────────────────────
d.text((W//2, 28), "Lesotho Health System Sandbox — High-Level Architecture",
       font=fnt_title, fill=C_DARK, anchor="mm")

# ── Row 1: Android app ───────────────────────────────────────────────
ax, ay = W//2 - BW//2, 65
box(ax, ay, BW, BH, C_ANDROID, "Android BKM App", "(OpenSRP 2)", "field device")

# ── Row 2: OpenHIM ───────────────────────────────────────────────────
ox, oy = W//2 - BW//2, 175
box(ox, oy, BW, BH, C_OPENHIM, "OpenHIM", "Intercept / Audit", ":5001 HTTP | :9000 UI")

arrow(W//2, ay+BH, W//2, oy, "FHIR R4  MedicationDispense")

# ── Row 3: bkm-mediator ──────────────────────────────────────────────
mx, my = W//2 - BW//2, 285
box(mx, my, BW, BH, C_MEDIATOR, "BKM Mediator", "Fan-out + Order Buffer", ":3000 internal")

arrow(W//2, oy+BH, W//2, my, "HTTP :3000")

# ── Row 4: fan-out targets ───────────────────────────────────────────
fan_y = 400
# OpenSRP
sx, sy = 120, fan_y
box(sx, sy, SBOX_W, SBOX_H, C_OPENSRP, "OpenSRP", "FHIR events", ":9900", text_color=C_DARK)

# HAPI FHIR
hx, hy = 290, fan_y
box(hx, hy, SBOX_W, SBOX_H, C_HAPI, "HAPI FHIR", "Config + Patients", ":8079")

# OpenLMIS
lx, ly = 680, fan_y
box(lx, ly, SBOX_W+20, SBOX_H, C_OPENLMIS, "OpenLMIS (eLMIS)", "Stock Events API", ":8082", text_color=C_DARK)

arrow(mx, my+BH//2, sx+SBOX_W, sy+SBOX_H//2, "")
d.line([(mx, my+BH//2), (sx+SBOX_W, sy+SBOX_H//2)], fill=C_ARROW, width=2)

arrow(mx+BW//3, my+BH, hx+SBOX_W//2, hy, "")

arrow(mx+BW, my+BH//2, lx, ly+SBOX_H//2, "")
d.line([(mx+BW, my+BH//2), (lx, ly+SBOX_H//2)], fill=C_ARROW, width=2)

# Label fan-out arrows properly
# Left branch
arrow(mx, my+BH//2, sx+SBOX_W//2, sy, "")
# Right branch
arrow(mx+BW, my+BH//2, lx+SBOX_W//2+10, ly, "")

# ── DHIS2 ────────────────────────────────────────────────────────────
dx2, dy2 = 680, 520
box(dx2, dy2, SBOX_W+20, SBOX_H, C_DHIS2, "DHIS2", "National Reporting", ":8081")

arrow(lx + (SBOX_W+20)//2, ly+SBOX_H, dx2+(SBOX_W+20)//2, dy2,
      "dhis2-integration\nstockCardSummaries")

# ── Shared services row ──────────────────────────────────────────────
row5_y = 650

# Keycloak
kx, ky = 120, row5_y
box(kx, ky, SBOX_W, SBOX_H, C_KEYCLOAK, "Keycloak", "Identity Provider", ":8083")

# PostgreSQL
px2, py2 = 310, row5_y
box(px2, py2, SBOX_W+10, SBOX_H, C_PG, "PostgreSQL", "All service DBs", ":5432")

# RabbitMQ
rx, ry = 500, row5_y
box(rx, ry, SBOX_W, SBOX_H, C_PG, "RabbitMQ", "OpenLMIS msgs", ":5672")

# MailHog
mhx, mhy = 690, row5_y
box(mhx, mhy, SBOX_W, SBOX_H, C_PG, "MailHog", "SMTP Sink", ":8025")

# dashed "depends on" lines from OpenSRP and OpenLMIS to Keycloak + PG
arrow(sx+SBOX_W//2, sy+SBOX_H, kx+SBOX_W//2, ky, "", color=(160,160,160), dashed=True)
arrow(lx+(SBOX_W+20)//2, ly+SBOX_H, px2+(SBOX_W+10)//2, py2, "", color=(160,160,160), dashed=True)

# ── Legend ────────────────────────────────────────────────────────────
lx2, ly2, lsize = 980, 200, 18
d.text((lx2, ly2-24), "Legend", font=fnt_bold, fill=C_DARK)
items = [
    (C_ANDROID,  "Android Field App"),
    (C_OPENHIM,  "OpenHIM (Interoperability Layer)"),
    (C_MEDIATOR, "BKM Mediator (Fan-out Engine)"),
    (C_OPENSRP,  "OpenSRP (Care Register)"),
    (C_HAPI,     "HAPI FHIR (App Config / Patients)"),
    (C_OPENLMIS, "OpenLMIS eLMIS (Stock Management)"),
    (C_DHIS2,    "DHIS2 (National Reporting)"),
    (C_KEYCLOAK, "Keycloak (Identity Provider)"),
    (C_PG,       "Shared Infrastructure"),
]
for i, (color, label) in enumerate(items):
    cy = ly2 + i * (lsize + 8)
    d.rounded_rectangle([lx2, cy, lx2+lsize, cy+lsize], radius=4, fill=color)
    tc = C_DARK if color == C_OPENSRP else C_DARK
    d.text((lx2 + lsize + 8, cy + lsize//2), label, font=fnt_small, fill=C_DARK, anchor="lm")

# ── Data flow legend ──────────────────────────────────────────────────
fl_y = ly2 + len(items) * (lsize + 8) + 20
d.text((lx2, fl_y), "Data Flows", font=fnt_bold, fill=C_DARK)
d.line([(lx2, fl_y+22), (lx2+40, fl_y+22)], fill=C_ARROW, width=2)
d.text((lx2+46, fl_y+22), "FHIR / REST call", font=fnt_small, fill=C_DARK, anchor="lm")
# dashed
for i in range(0, 40, 8):
    d.line([(lx2+i, fl_y+38), (lx2+i+5, fl_y+38)], fill=(160,160,160), width=2)
d.text((lx2+46, fl_y+38), "Shared dependency", font=fnt_small, fill=C_DARK, anchor="lm")

# ── border ────────────────────────────────────────────────────────────
d.rounded_rectangle([6, 6, W-6, H-6], radius=16, outline=C_BORDER, width=2)

out = "c:/Users/Neels.Lotter/lesotho-vitallink/docs/architecture-diagram.png"
img.save(out, "PNG", dpi=(150, 150))
print(f"Saved: {out}  ({W}x{H})")
