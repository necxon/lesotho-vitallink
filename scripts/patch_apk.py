"""
Patch server URLs in an OpenSRP FHIR Core APK (DEX byte-patch).

⚠️  LIMITATION — SAME-LENGTH REPLACEMENTS ONLY ⚠️
DEX stores string offsets in tables (string_ids, map_list) that this script does
NOT rewrite. If new_bytes differ in length from old_bytes, every subsequent string
offset shifts → the DEX is corrupted → the app crashes on launch
("Activity class ... does not exist"). It only recomputes the per-string ULEB128
size + file checksums, which is insufficient for length changes.

  ✅ OK:  http://10.0.2.2:8079/fhir/  →  http://localhost:8079/fhir  (same length)
  ❌ NO:  http://localhost:8079/fhir/ →  https://fhir.lesotho-bkm.xyz/fhir/ (longer → crash)

For PROD URLs (longer than localhost), DO NOT use this — rebuild from source instead:
  android/fhircore/android/local.properties  (set FHIR_BASE_URL / OAUTH_BASE_URL)
  cd android/fhircore/android && ./gradlew :quest:assembleOpensrpDebug
  adb install -r quest/build/outputs/apk/opensrp/debug/quest-opensrp-debug.apk

Usage (same-length only): edit PATCHES below, then `python patch_apk.py`.
"""
import zipfile, struct, hashlib, sys

SRC      = r"fhir-lesotho-source-debug.apk"
DST      = r"fhir-lesotho-patched.apk"
DEX_FILE = "classes10.dex"

# ── Edit these for each deployment target ─────────────────────────────────────
# Production HTTPS endpoints (lesotho-bkm.xyz, behind Let's Encrypt).
# Each tuple is (old_bytes, new_bytes); the script skips any old_bytes not found,
# so listing every plausible current value (emulator 10.0.2.2, prod IP) is safe.
#
# Each tuple matches a COMPLETE DEX string (length-prefix + bytes + null terminator),
# not a substring — so the full URL incl. path must be given. Variable lengths are OK
# (ULEB128 size prefix is rewritten). Listing every plausible current value is safe;
# missing ones are skipped with a warning.
# The 0.0.0.0 entries are placeholders: set them to the server IP the APK was
# actually built against, or they simply never match and are skipped.
PATCHES = [
    # FHIR base URL (full string in classes10.dex)
    (b"http://localhost:8079/fhir/",        b"https://fhir.lesotho-bkm.xyz/fhir/"),
    (b"http://10.0.2.2:8079/fhir/",         b"https://fhir.lesotho-bkm.xyz/fhir/"),
    (b"http://0.0.0.0:8079/fhir/",          b"https://fhir.lesotho-bkm.xyz/fhir/"),

    # Keycloak OAuth base URL (full string in classes10.dex; KC now under /auth)
    (b"http://localhost:8083/realms/opensrp/",        b"https://lesotho-bkm.xyz/auth/realms/opensrp/"),
    (b"http://10.0.2.2:8083/realms/opensrp/",         b"https://lesotho-bkm.xyz/auth/realms/opensrp/"),
    (b"http://0.0.0.0:8083/realms/opensrp/",          b"https://lesotho-bkm.xyz/auth/realms/opensrp/"),
]
# ──────────────────────────────────────────────────────────────────────────────


def encode_uleb128(value):
    """Encode a non-negative integer as ULEB128 bytes."""
    result = []
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            byte |= 0x80
        result.append(byte)
        if not value:
            break
    return bytes(result)


def decode_uleb128(data, offset):
    """Decode ULEB128 at data[offset]. Returns (value, bytes_consumed)."""
    result, shift, consumed = 0, 0, 0
    while True:
        b = data[offset + consumed]
        result |= (b & 0x7F) << shift
        consumed += 1
        if not (b & 0x80):
            break
        shift += 7
    return result, consumed


def patch_dex_string(data, old_bytes, new_bytes):
    """
    Replace all occurrences of old_bytes with new_bytes in the DEX string table,
    updating the ULEB128 utf16_size prefix for each occurrence.

    In a DEX string_data_item the layout is:
        ULEB128  utf16_size   (number of UTF-16 code units — equals byte length
                               for ASCII-only strings)
        bytes    mutf8_data   (the string bytes)
        0x00     terminator

    We locate old_bytes in the DEX, walk back to find the ULEB128 prefix,
    verify it encodes len(old_bytes), then replace prefix + payload in one shot.
    """
    old_len  = len(old_bytes)
    new_len  = len(new_bytes)
    old_uleb = encode_uleb128(old_len)
    new_uleb = encode_uleb128(new_len)

    result   = bytearray(data)
    replaced = 0
    search_from = 0

    while True:
        idx = result.find(old_bytes, search_from)
        if idx == -1:
            break

        # Walk back over the ULEB128 prefix — it immediately precedes old_bytes.
        prefix_end = idx
        # The ULEB128 can be at most 5 bytes for a 32-bit value.
        # Scan back to find where it starts.
        found_prefix = False
        for prefix_len in range(1, 6):
            prefix_start = prefix_end - prefix_len
            if prefix_start < 0:
                break
            candidate = bytes(result[prefix_start:prefix_end])
            val, consumed = decode_uleb128(candidate, 0)
            if consumed == prefix_len and val == old_len:
                found_prefix = True
                break

        if not found_prefix:
            # String found but not preceded by the expected ULEB128 — skip.
            search_from = idx + 1
            continue

        # Verify null terminator follows the old string.
        term_idx = idx + old_len
        if term_idx >= len(result) or result[term_idx] != 0x00:
            search_from = idx + 1
            continue

        # Replace: [uleb128][old_bytes][0x00] → [new_uleb128][new_bytes][0x00]
        start = prefix_start
        end   = term_idx + 1  # include the null terminator
        replacement = new_uleb + new_bytes + b'\x00'
        result[start:end] = replacement
        replaced += 1
        search_from = start + len(replacement)

    if replaced == 0:
        print(f"  WARNING: '{old_bytes.decode()}' not found — skipping")
    else:
        print(f"  Replaced {replaced} occurrence(s): {old_bytes.decode()!r} → {new_bytes.decode()!r}")

    # Update DEX file_size field (bytes 32-35, little-endian uint32)
    result[32:36] = struct.pack('<I', len(result))

    return bytes(result)


def recompute_checksums(data):
    """Recompute SHA-1 (bytes 12-31) and Adler-32 (bytes 8-11) in a DEX file."""
    data = bytearray(data)
    # SHA-1 covers bytes 32..end
    sha1 = hashlib.sha1(data[32:]).digest()
    data[12:32] = sha1
    # Adler-32 covers bytes 12..end (which now includes the new SHA-1)
    s1, s2 = 1, 0
    for b in data[12:]:
        s1 = (s1 + b) % 65521
        s2 = (s2 + s1) % 65521
    data[8:12] = struct.pack('<I', (s2 << 16) | s1)
    return bytes(data)


# Scan EVERY classes*.dex — the URL strings may live in any DEX, not just one.
import re as _re
_dex_re = _re.compile(r'^classes\d*\.dex$')

with zipfile.ZipFile(SRC, 'r') as zin, zipfile.ZipFile(DST, 'w') as zout:
    for info in zin.infolist():
        data = zin.read(info.filename)
        if _dex_re.match(info.filename):
            # Only rewrite this DEX if it actually contains one of the targets
            if any(old in data for old, _ in PATCHES):
                print(f"Patching {info.filename} ({len(data):,} bytes)...")
                for old, new in PATCHES:
                    if old in data:
                        data = patch_dex_string(data, old, new)
                data = recompute_checksums(data)
                print(f"  Checksums recomputed. New size: {len(data):,} bytes")
        # Drop V1 signature files (they're invalid after patching)
        if info.filename.startswith("META-INF/") and \
           info.filename.split(".")[-1].upper() in ("SF", "RSA", "DSA", "MF"):
            print(f"  Skipping signature: {info.filename}")
            continue
        zout.writestr(info, data, compress_type=info.compress_type)

print(f"\nWritten: {DST}")
print("Note: APK is unsigned. Install with: adb install --no-streaming fhir-lesotho-patched.apk")
print("      Or re-sign with apksigner if device requires signed APKs.")
