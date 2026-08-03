local logger = require("logger")
local millennium = require("millennium")
local http = require("http")
local is_windows = package.config:sub(1, 1) == "\\"
if is_windows then
    utils = require("utils")
end

local CACHE_DIR = os.getenv("HOME") .. "/.local/share/millennium/plugins/steam-easygrid-linux/cache/"

os.execute("mkdir -p " .. CACHE_DIR)

local function url_hash(url)
    local h = io.popen(string.format("echo -n %q | md5sum | cut -c1-16", url))
    local result = h and h:read("*a") or ""
    if h then h:close() end
    return result:match("^%s*(.-)%s*$")
end

-- SteamGridDB serves every WebP asset under a second, ".png"-suffixed URL
-- (the site's "Download as .PNG" button): identical bytes, relabeled
-- extension. Steam's asset loader content-sniffs and natively animates
-- animated-WebP bytes as long as the filename says .png — so fetching the
-- fakepng variant and handing it to Steam unmodified is the entire
-- pipeline. Assets that are already .png / .jpg / .ico have no fakepng
-- variant (none is needed) and are fetched as-is.
local function fakepng_url(img_url)
    if img_url:match("%.webp$") then
        return img_url:gsub("%.webp$", "-fakepng.png")
    end
    return img_url
end

-- Cache key hashes the URL that is actually fetched, so a fakepng fetch and
-- any historical raw-.webp fetch of the same asset can never collide on one
-- cache filename.
local function get_cache_path(appid, imagetype, img_url)
    local hash = url_hash(fakepng_url(img_url))
    return CACHE_DIR .. tostring(appid) .. "_" .. tostring(imagetype) .. "_" .. hash .. ".png"
end

function call_api_backend(a_bearer, b_endpoint)
    local bearer = a_bearer
    local endpoint = "https://www.steamgriddb.com/api/v2/" .. b_endpoint
    logger:info("Querying endpoint " .. endpoint)
    local response, err = http.get(endpoint, {
        headers = {
            ["Accept"] = "application/json",
            ["Authorization"] = "Bearer " .. bearer,
        }
    })
    if not response then logger:error(err); return "" end
    if response.status ~= 200 then
        logger:error(string.format("Got HTTP %d", response.status))
        return string.format("{ \"http_status\": %d }", response.status)
    end
    return response.body
end

-- Durable plugin configuration. Steam clears its CEF localStorage on
-- client updates and "delete web browser data", silently wiping any
-- settings stored there (including the API key). config.json in the
-- plugin directory survives all of that — and is gitignored, so the
-- key can never be committed.
local CONFIG_PATH = os.getenv("HOME") .. "/.local/share/millennium/plugins/steam-easygrid-linux/config.json"

function get_config()
    local f = io.open(CONFIG_PATH, "rb")
    if not f then return "{}" end
    local data = f:read("*a"); f:close()
    if not data or data == "" then return "{}" end
    return data
end

-- NOTE: Millennium passes params alphabetically: config_json
function set_config(config_json)
    local f = io.open(CONFIG_PATH, "wb")
    if not f then logger:error("set_config: cannot write " .. CONFIG_PATH); return "FAILED" end
    f:write(tostring(config_json)); f:close()
    return "OK"
end

function log_frontend(msg)
    logger:info("[frontend] " .. tostring(msg))
end

-- ── Icons (imagetype 4): the librarycache route ─────────────────────────
-- Steam has no custom-artwork API for real games' icons; the working
-- community mechanism is overwriting the cached icon file that Steam
-- reads by name. Modern layout: librarycache/<appid>/ holds hash-named
-- SUBDIRECTORIES for the big assets plus ONE flat .jpg file — the icon.
-- Older clients: a flat librarycache/<appid>_icon.jpg instead. Steam
-- content-sniffs the bytes (PNG-in-.jpg renders fine, alpha respected),
-- so the fetched SGDB icon is written as-is — no conversion.
local function find_icon_slots(appid)
    local lc = os.getenv("HOME") .. "/.local/share/Steam/appcache/librarycache/"
    local dir = lc .. tostring(appid)
    local slots = {}
    -- Named layout (older cache format): the icon file is literally icon.jpg,
    -- alongside header.jpg / library_hero.jpg / etc. Only icon.jpg is the
    -- icon — overwriting the other flat .jpg files here clobbers the game's
    -- header/grid/hero caches, which is exactly the mistake this rewrite of
    -- the slot heuristic exists to prevent.
    local named = dir .. "/icon.jpg"
    local f = io.open(named, "rb")
    if f then f:close(); slots[#slots + 1] = named; return slots end
    -- Hash layout (modern format): sized assets live in hash-named
    -- subdirectories; the icon is the flat .jpg whose basename is a
    -- 40-char hex hash. Matching the hash shape excludes any named files.
    local h = io.popen(string.format("find %q -maxdepth 1 -type f -name '*.jpg' 2>/dev/null", dir))
    if h then
        for line in h:lines() do
            local base = line:match("([^/]+)%.jpg$")
            if base and #base == 40 and base:match("^%x+$") and not line:match("%.easygrid%-backup") then
                slots[#slots + 1] = line
            end
        end
        h:close()
    end
    if #slots > 0 then return slots end
    -- Legacy flat layout (oldest clients)
    local legacy = lc .. tostring(appid) .. "_icon.jpg"
    f = io.open(legacy, "rb")
    if f then f:close(); slots[#slots + 1] = legacy end
    return slots
end

-- Overwrites each icon slot with the cached file, preserving Steam's
-- original bytes in a one-time .easygrid-backup sidecar for restore_icon.
local function apply_icon(appid, cached)
    local slots = find_icon_slots(appid)
    if #slots == 0 then
        logger:error("apply_icon: no icon slot found in librarycache for appid " .. tostring(appid))
        return 0
    end
    local n = 0
    for _, slot in ipairs(slots) do
        local bak = slot .. ".easygrid-backup"
        local bf = io.open(bak, "rb")
        if bf then bf:close() else os.execute(string.format("cp %q %q", slot, bak)) end
        os.execute(string.format("chmod u+w %q 2>/dev/null", slot))
        if os.execute(string.format("cp %q %q", cached, slot)) then
            logger:info(string.format("apply_icon: %s -> %s", cached, slot))
            n = n + 1
        end
    end
    return n
end

-- IPC-safety ceiling: a 13.3MB payload (~17.7M b64 chars) previously hung
-- Millennium's Lua→JS return entirely. 6MB raw (~8M b64 chars) is the
-- proven-safe ceiling from the r1 "direct base64 path" baseline.
local MAX_IPC_BYTES = 6 * 1024 * 1024

-- Chunk size for oversized transfers: 4M base64 chars per IPC return
-- (~3MB raw), comfortably inside the proven-safe single-return range.
local CHUNK_B64_CHARS = 4 * 1024 * 1024

-- The one artwork pipeline. Downloads the ready-to-use file from
-- SteamGridDB (fakepng variant for WebP assets, the file as-is otherwise),
-- caches it, and returns its base64 so the frontend can hand the full,
-- untouched bytes to SetCustomArtworkForApp — exactly what Steam's own
-- "Set custom artwork" dialog does, which is the flow proven to animate.
-- No conversion, no preview generation, no re-encoding of any kind.
--
-- Returns:
--   <base64>                     on success (file is <= 6MB, single return)
--   "CHUNKED:<nchunks>:<chars>"  oversized file: base64 is staged in a
--                                sidecar file and streamed to the frontend
--                                via get_artwork_chunk, so any size applies
--                                instantly with no restart and no single
--                                giant IPC return (the only thing the 6MB
--                                ceiling actually protects against)
--   "FAILED:<reason>"            on error
-- NOTE: Millennium passes params alphabetically: appid, imagetype, img_url
function fetch_artwork(appid, imagetype, img_url)
    logger:info(string.format("fetch_artwork: appid=%s type=%s url=%s", tostring(appid), tostring(imagetype), img_url))

    local fetch_url = fakepng_url(img_url)
    local is_fakepng = (fetch_url ~= img_url)
    local cached = get_cache_path(appid, imagetype, img_url)

    -- Windows: Linux-first fork; kept functional via http.get, no disk
    -- cache and no oversized-file fallback (grid-dir discovery is Linux-only).
    if is_windows then
        local response = http.get(fetch_url)
        if (not response or response.status ~= 200) and is_fakepng then
            logger:warn("fetch_artwork: fakepng fetch failed on Windows, retrying original URL")
            response = http.get(img_url)
        end
        if not response or response.status ~= 200 then return "FAILED:download" end
        if #response.body > MAX_IPC_BYTES then
            logger:error(string.format("fetch_artwork: too large for IPC on Windows: %d bytes", #response.body))
            return "FAILED:too_large"
        end
        return utils.base64_encode(response.body)
    end

    -- Download to cache if not already there
    local hf = io.open(cached, "rb")
    if hf then
        hf:close()
        logger:info("fetch_artwork: cache hit " .. cached)
    else
        local tmpfile = "/tmp/sgdb_fetch_" .. tostring(appid) .. "_" .. tostring(imagetype) .. ".bin"

        local function try_download(url)
            local dl = io.popen(string.format(
                "env -u LD_LIBRARY_PATH curl -s -L --max-time 120 --max-filesize 104857600 " ..
                "-H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64)' " ..
                "-H 'Referer: https://www.steamgriddb.com/' " ..
                "-w '%%{http_code}' -o %q %q 2>/dev/null",
                tmpfile, url
            ))
            if not dl then return nil, 0 end
            local http_code = dl:read("*a"); dl:close()
            local sz_h = io.open(tmpfile, "rb")
            local fsize = 0
            if sz_h then fsize = sz_h:seek("end"); sz_h:close() end
            return http_code, fsize
        end

        local http_code, fsize = try_download(fetch_url)

        -- A missing fakepng variant is harmless: the original .webp URL
        -- serves byte-identical content, so fall back to it transparently.
        if is_fakepng and (http_code ~= "200" or fsize == 0) then
            logger:warn(string.format("fetch_artwork: fakepng fetch failed (http=%s), falling back to original URL", tostring(http_code)))
            http_code, fsize = try_download(img_url)
        end

        if http_code ~= "200" or fsize == 0 then
            logger:error(string.format("fetch_artwork: download failed (http=%s, size=%d)", tostring(http_code), fsize))
            os.remove(tmpfile)
            return "FAILED:download"
        end

        os.execute(string.format("mv %q %q", tmpfile, cached))
        logger:info(string.format("fetch_artwork: downloaded %d bytes -> %s", fsize, cached))
    end

    -- Icons never go through SetCustomArtworkForApp (Steam ignores asset
    -- type 4 for real games) — they are applied directly to librarycache.
    -- A Steam restart is needed for the library list to re-read the file.
    if tostring(imagetype) == "4" then
        local applied = apply_icon(appid, cached)
        if applied > 0 then return "ICON_APPLIED:" .. tostring(applied) end
        return "FAILED:no_icon_slot"
    end

    -- Size gate: full bytes through IPC when safe, direct file placement when not
    local sz_h = io.open(cached, "rb")
    local fsize = sz_h and sz_h:seek("end") or 0
    if sz_h then sz_h:close() end
    if fsize == 0 then return "FAILED:empty_cache" end

    if fsize > MAX_IPC_BYTES then
        -- Stage the base64 once in a sidecar; the frontend pulls it in
        -- fixed-size pieces via get_artwork_chunk and reassembles.
        local b64_path = cached .. ".b64"
        local bf = io.open(b64_path, "rb")
        if not bf then
            os.execute(string.format("env -u LD_LIBRARY_PATH base64 -w 0 %q > %q", cached, b64_path))
            bf = io.open(b64_path, "rb")
        end
        if not bf then logger:error("fetch_artwork: b64 staging failed"); return "FAILED:encode" end
        local total = bf:seek("end"); bf:close()
        if not total or total == 0 then return "FAILED:encode" end
        local nchunks = math.ceil(total / CHUNK_B64_CHARS)
        logger:info(string.format("fetch_artwork: %d bytes exceeds single-IPC ceiling, chunked transfer (%d chunks, %d chars)", fsize, nchunks, total))
        return string.format("CHUNKED:%d:%d", nchunks, total)
    end

    local b64_handle = io.popen(string.format("env -u LD_LIBRARY_PATH base64 -w 0 %q", cached))
    if not b64_handle then logger:error("fetch_artwork: base64 popen failed"); return "FAILED:encode" end
    local b64 = b64_handle:read("*a"); b64_handle:close()
    logger:info(string.format("fetch_artwork: encoded %d chars", #(b64 or "")))
    return b64 or "FAILED:encode"
end

-- Returns one fixed-size piece of a staged base64 sidecar. The frontend
-- calls this in a loop after fetch_artwork returns CHUNKED and concatenates
-- the pieces — each return stays far below the bridge-hang threshold.
-- NOTE: Millennium passes params alphabetically: appid, chunk, imagetype, img_url
function get_artwork_chunk(appid, chunk, imagetype, img_url)
    local b64_path = get_cache_path(appid, imagetype, img_url) .. ".b64"
    local f = io.open(b64_path, "rb")
    if not f then logger:error("get_artwork_chunk: sidecar missing: " .. tostring(b64_path)); return "" end
    f:seek("set", (tonumber(chunk) or 0) * CHUNK_B64_CHARS)
    local data = f:read(CHUNK_B64_CHARS)
    f:close()
    return data or ""
end

-- Restores Steam's original icon from the .easygrid-backup sidecars
-- created on first overwrite. Returns the number of slots restored.
function restore_icon(appid)
    local slots = find_icon_slots(appid)
    local n = 0
    for _, slot in ipairs(slots) do
        local bak = slot .. ".easygrid-backup"
        local bf = io.open(bak, "rb")
        if bf then
            bf:close()
            os.execute(string.format("chmod u+w %q 2>/dev/null", slot))
            if os.execute(string.format("cp %q %q", bak, slot)) then
                logger:info("restore_icon: restored " .. slot)
                n = n + 1
            end
        end
    end
    return "RESTORED:" .. tostring(n)
end

-- Deletes cache files for a specific game + image type
-- NOTE: Millennium passes params alphabetically: appid, imagetype
function purge_game_cache(appid, imagetype)
    local base = string.format("%s%s_%s_", CACHE_DIR, tostring(appid), tostring(imagetype))
    os.execute(string.format("rm -f %s*.png %s*.png.lock %s*.b64", base, base, base))
    logger:info(string.format("purge_game_cache: cleared %s%s_%s_*", CACHE_DIR, tostring(appid), tostring(imagetype)))
    return "OK"
end

-- Deletes all cache files
function purge_all_cache()
    os.execute(string.format("rm -f %s*.png %s*.b64", CACHE_DIR, CACHE_DIR))
    logger:info("purge_all_cache: cleared all cache files")
    return "OK"
end

local function on_frontend_loaded()
    logger:info("Frontend loaded")
end

local function on_load()
    logger:info("Backend loaded")
    millennium.ready()
end

local function on_unload()
    logger:info("Backend unloaded")
end

return {
    on_frontend_loaded = on_frontend_loaded,
    on_load = on_load,
    on_unload = on_unload
}
