local logger = require("logger")
local millennium = require("millennium")
local http = require("http")
local is_windows = package.config:sub(1, 1) == "\\"
if is_windows then
    utils = require("utils")
end

local HELPER_SCRIPT = os.getenv("HOME") .. "/.local/share/millennium/plugins/steam-easygrid/backend/webp_to_apng.py"
local CACHE_DIR = os.getenv("HOME") .. "/.local/share/millennium/plugins/steam-easygrid/cache/"

os.execute("mkdir -p " .. CACHE_DIR)

local function url_hash(url)
    local h = io.popen(string.format("echo -n %q | md5sum | cut -c1-16", url))
    local result = h and h:read("*a") or ""
    if h then h:close() end
    return result:match("^%s*(.-)%s*$")
end

local function get_cache_path(appid, imagetype, img_url)
    local hash = url_hash(img_url)
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

-- Polls whether the APNG conversion is complete
-- NOTE: Millennium passes params alphabetically: appid, imagetype, img_url
function check_artwork_ready(appid, imagetype, img_url)
    -- Only check the main APNG file — it is written via atomic os.rename() so its
    -- presence guarantees the conversion is fully complete.  The _preview.png is
    -- saved BEFORE the rename, so checking it first caused a false-positive READY
    -- while the APNG was still named .png.tmp.
    local cached = get_cache_path(appid, imagetype, img_url)
    local h = io.open(cached, "r")
    if h then h:close(); logger:info("Cache ready: " .. cached); return "READY" end
    return "PENDING"
end

-- Downloads animated WebP, converts to APNG in background, returns status
-- NOTE: Millennium passes params alphabetically: appid, imagetype, img_url (via img_url=)
function set_animated_artwork(appid, imagetype, img_url)
    logger:info(string.format("set_animated_artwork: appid=%s type=%s url=%s", tostring(appid), tostring(imagetype), img_url))

    local cached = get_cache_path(appid, imagetype, img_url)
    local tmpfile = "/tmp/sgdb_anim_" .. tostring(appid) .. "_" .. tostring(imagetype) .. ".bin"

    -- Return immediately if already cached
    local hf = io.open(cached, "r")
    if hf then hf:close(); logger:info("Cache hit: " .. cached); return "CACHED" end

    -- Download
    local dl_handle = io.popen(string.format(
        "env -u LD_LIBRARY_PATH curl -s -L --max-time 120 --max-filesize 104857600 " ..
        "-H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64)' " ..
        "-H 'Referer: https://www.steamgriddb.com/' " ..
        "-w '%%{size_download}/%%{size_download}' -o %q %q 2>/dev/null",
        tmpfile, img_url
    ))
    if not dl_handle then logger:error("io.popen unavailable"); return "FAILED" end
    dl_handle:read("*a"); dl_handle:close()

    local sz_h = io.open(tmpfile, "rb")
    local fsize = 0
    if sz_h then fsize = sz_h:seek("end"); sz_h:close() end
    if fsize == 0 then logger:error("Download failed or empty"); os.remove(tmpfile); return "FAILED" end
    logger:info(string.format("Downloaded %d bytes, starting background conversion", fsize))

    -- Convert in background — atomic rename in webp_to_apng.py ensures cache file
    -- only appears once fully written, preventing check_artwork_ready false positives
    local bg_cmd = string.format(
        "nohup env -u LD_LIBRARY_PATH bash -c 'python3 %q %q %q && rm -f %q' > /tmp/sgdb_conv_%s.log 2>&1 &",
        HELPER_SCRIPT, tmpfile, cached, tmpfile,
        tostring(appid) .. "_" .. tostring(imagetype)
    )
    os.execute(bg_cmd)
    logger:info("Background conversion started, cache target: " .. cached)
    return "CONVERTING"
end

-- Encodes a static image as base64 for SetCustomArtworkForApp
local function get_encoded_image_linux(img_url)
    local tmpfile = "/tmp/sgdb_" .. tostring(os.time()) .. ".bin"
    local dl_handle = io.popen(string.format(
        "env -u LD_LIBRARY_PATH curl -s -L --max-time 120 --max-filesize 104857600 " ..
        "-H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64)' " ..
        "-H 'Referer: https://www.steamgriddb.com/' " ..
        "-w '%%{http_code}' -o %q %q 2>&1",
        tmpfile, img_url
    ))
    if not dl_handle then logger:error("io.popen unavailable"); return "" end
    local curl_out = dl_handle:read("*a"); dl_handle:close()
    if curl_out ~= "200" then logger:error("curl failed: " .. tostring(curl_out)); os.remove(tmpfile); return "" end
    local sz_h = io.popen(string.format("stat -c%%s %q 2>/dev/null", tmpfile))
    local fsize = tonumber(sz_h and sz_h:read("*a") or "0") or 0
    if sz_h then sz_h:close() end
    if fsize == 0 then logger:error("Downloaded file is empty"); os.remove(tmpfile); return "" end
    logger:info(string.format("Image size: %d bytes", fsize))
    local b64_handle = io.popen(string.format("env -u LD_LIBRARY_PATH base64 -w 0 %q", tmpfile))
    if not b64_handle then logger:error("base64 popen failed"); os.remove(tmpfile); return "" end
    local b64 = b64_handle:read("*a"); b64_handle:close(); os.remove(tmpfile)
    logger:info(string.format("Image encoded %d chars", #(b64 or "")))
    return b64 or ""
end

local function get_encoded_image_windows(img_url)
    local response, err = http.get(img_url)
    if not response then logger:error(err); return "" end
    if response.status ~= 200 then logger:error(string.format("Got HTTP %d", response.status)); return "" end
    if #response.body > 100 * 1024 * 1024 then logger:warn("Image too large"); return "" end
    return utils.base64_encode(response.body)
end

function get_encoded_image(img_url)
    logger:info("Requesting image " .. img_url)
    if is_windows then return get_encoded_image_windows(img_url) else return get_encoded_image_linux(img_url) end
end

function log_frontend(msg)
    logger:info("[frontend] " .. tostring(msg))
end

-- Maps imagetype to Steam grid filename suffix
local TYPE_SUFFIXES = {["0"]="p", ["1"]="_hero", ["2"]="_logo", ["3"]="", ["4"]="_icon"}

-- Copies cached APNG to Steam's grid folder for persistence across restarts
-- NOTE: Millennium passes params alphabetically: appid, imagetype, img_url
function apply_grid_artwork(appid, imagetype, img_url)
    local cached = get_cache_path(appid, imagetype, img_url)
    local cf = io.open(cached, "rb")
    if not cf then logger:error("apply_grid_artwork: cache file not found: " .. tostring(cached)); return "ERROR:no_cache" end
    cf:close()

    local suffix = TYPE_SUFFIXES[tostring(imagetype)] or "_hero"
    local dest_name = tostring(appid) .. suffix .. ".png"
    local home = os.getenv("HOME") or ""
    local h = io.popen("find " .. home .. "/.local/share/Steam/userdata -maxdepth 3 -name grid -type d 2>/dev/null | head -1")
    local grid_dir = h and h:read("*a"):gsub("%s*$", "") or ""
    if h then h:close() end

    if grid_dir == "" then logger:error("apply_grid_artwork: could not find Steam grid directory"); return "ERROR:no_grid_dir" end

    local dest = grid_dir .. "/" .. dest_name
    local ok = os.execute(string.format("cp %q %q", cached, dest))
    if ok then logger:info(string.format("apply_grid_artwork: %s -> %s", cached, dest)); return "OK"
    else logger:error("apply_grid_artwork: copy failed"); return "ERROR:copy_failed" end
end

-- Returns base64 of the first-frame preview PNG for immediate SetCustomArtworkForApp display
-- NOTE: Millennium passes params alphabetically: appid, imagetype, img_url
function get_preview_b64(appid, imagetype, img_url)
    local cached = get_cache_path(appid, imagetype, img_url)
    local preview = cached:gsub("%.png$", "_preview.png")
    local f = io.open(preview, "r")
    if not f then logger:error("get_preview_b64: preview not found: " .. tostring(preview)); return "" end
    f:close()
    local h = io.popen(string.format("env -u LD_LIBRARY_PATH base64 -w0 %q 2>/dev/null", preview))
    local b64 = h and h:read("*a"):gsub("%s", "") or ""
    if h then h:close() end
    logger:info(string.format("get_preview_b64: %d chars", #b64))
    return b64
end

-- Returns just the cache filename for constructing a localhost HTTP URL
-- NOTE: Millennium passes params alphabetically: appid, imagetype, img_url
function get_cache_filename(appid, imagetype, img_url)
    local cached = get_cache_path(appid, imagetype, img_url)
    return cached:match("([^/]+)$") or ""
end

-- Deletes cache files for a specific game + image type
-- NOTE: Millennium passes params alphabetically: appid, imagetype
function purge_game_cache(appid, imagetype)
    local base = string.format("%s%s_%s_", CACHE_DIR, tostring(appid), tostring(imagetype))
    os.execute(string.format("rm -f %s*.png %s*.png.lock", base, base))
    logger:info(string.format("purge_game_cache: cleared %s%s_%s_*", CACHE_DIR, tostring(appid), tostring(imagetype)))
    return "OK"
end

-- Deletes all cache files
function purge_all_cache()
    os.execute(string.format("rm -f %s*.png", CACHE_DIR))
    logger:info("purge_all_cache: cleared all cache files")
    return "OK"
end

local function on_frontend_loaded()
    logger:info("Frontend loaded")
end


-- Returns the filename of the cached APNG for a game/type, or "" if none exists.
-- Used by the frontend to re-apply animated heroes on navigation —
-- filesystem check works across all JS contexts, no shared-state needed.
-- NOTE: Millennium passes params alphabetically: appid, imagetype
function get_cached_anim_filename(appid, imagetype)
    local prefix = tostring(appid) .. "_" .. tostring(imagetype) .. "_"
    local h = io.popen(string.format(
        "find %q -maxdepth 1 -name '%s*.png' ! -name '*_preview.png' -printf '%%f\n' 2>/dev/null | head -1",
        CACHE_DIR, prefix
    ))
    local result = h and h:read("*a"):gsub("%s*$", "") or ""
    if h then h:close() end
    return result
end


-- Saves a base64-encoded logo PNG to:
--   cache/{appid}_2_logo.png  (served via HTTP for DOM overlay)
--   grid/{appid}_logo.png     (Steam persistence across restarts)
-- Returns the cache filename on success, "" on failure.
-- NOTE: Millennium passes params alphabetically: appid, b64data
-- Downloads a logo, caches it in CACHE_DIR as {appid}_2_logo.png, and writes to
-- Steam's grid folder. Uses the same naming pattern as get_cached_anim_filename
-- so the HTTP server can serve it and the re-apply logic can find it on navigation.
-- NOTE: Millennium passes params alphabetically: appid, img_url
function cache_and_apply_logo(appid, img_url)
    local filename = tostring(appid) .. "_2_logo.png"
    local cache_path = CACHE_DIR .. filename
    local grid_dir = os.getenv("HOME") .. "/.local/share/Steam/userdata/" .. STEAM_USER_ID .. "/config/grid/"
    local grid_path = grid_dir .. tostring(appid) .. "_logo.png"

    -- Download binary directly to cache.
    -- `timeout 12` guarantees the subprocess exits even if curl ignores --max-time.
    local dl = io.popen(string.format(
        "timeout 12 env -u LD_LIBRARY_PATH curl -s -L --max-time 10 " ..
        "-H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64)' " ..
        "-H 'Referer: https://www.steamgriddb.com/' " ..
        "-w '%%{http_code}' -o %q %q 2>/dev/null",
        cache_path, img_url
    ))
    local http_code = dl and dl:read("*a"):gsub("%s+", "") or ""
    if dl then dl:close() end

    if http_code ~= "200" then
        logger:error("Logo download failed HTTP " .. http_code)
        return ""
    end

    local f = io.open(cache_path, "rb")
    if not f then return "" end
    local sz = f:seek("end"); f:close()
    if not sz or sz < 100 then return "" end

    -- Copy to Steam grid folder (shows logo in library on restart)
    os.execute(string.format("cp %q %q", cache_path, grid_path))
    logger:info(string.format("Logo cached: %s (%d bytes)", filename, sz))
    return filename  -- return filename so frontend can build HTTP URL
end


-- Downloads a logo binary, caches it locally, copies to Steam's grid folder,
-- and returns its base64 encoding for SetCustomArtworkForApp.
-- This mirrors Steam's own "Set Custom Logo" pathway exactly:
-- download → write to grid folder → pass base64 to Steam API.
-- NOTE: params alphabetically: appid, img_url
function cache_logo(appid, img_url)
    logger:info(string.format("cache_logo: start appid=%s", tostring(appid)))
    local logos_dir = CACHE_DIR .. "logos/"
    os.execute("mkdir -p " .. logos_dir)
    local cache_path = logos_dir .. tostring(appid) .. "_2_logo.png"
    local grid_dir = os.getenv("HOME") .. "/.local/share/Steam/userdata/" .. STEAM_USER_ID .. "/config/grid/"
    local grid_path = grid_dir .. tostring(appid) .. "_logo.png"
    local tmpfile = "/tmp/sgdb_logo_" .. tostring(appid) .. ".bin"

    local h = io.popen(string.format(
        "timeout 20 env -u LD_LIBRARY_PATH curl -s -L --max-time 15 " ..
        "-H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64)' " ..
        "-H 'Referer: https://www.steamgriddb.com/' " ..
        "-w '%%{http_code}' -o %q %q 2>/dev/null",
        tmpfile, img_url
    ))
    local http_code = h and h:read("*a"):gsub("%s+$", "") or ""
    if h then h:close() end

    if http_code ~= "200" then
        logger:error(string.format("cache_logo: HTTP %s", tostring(http_code)))
        os.remove(tmpfile); return ""
    end
    local f = io.open(tmpfile, "rb")
    if not f then logger:error("cache_logo: no tmpfile"); return "" end
    local sz = f:seek("end"); f:close()
    if not sz or sz < 100 then
        logger:error("cache_logo: file too small"); os.remove(tmpfile); return ""
    end
    os.execute(string.format("cp %q %q", tmpfile, cache_path))
    os.execute(string.format("cp %q %q", tmpfile, grid_path))
    os.remove(tmpfile)
    logger:info(string.format("cache_logo: saved %s (%d bytes)", tostring(appid), sz))
    return "OK"
end


-- Downloads a static PNG/JPG image, caches it, and creates a compressed preview
-- small enough to return via IPC for SetCustomArtworkForApp.
-- Mirrors the animated hero pipeline but for static images.
-- NOTE: params alphabetically: appid, imagetype, img_url
function set_static_artwork(appid, imagetype, img_url)
    local cache_path   = get_cache_path(appid, imagetype, img_url)
    local preview_path = cache_path:gsub("%.png$", "_preview.png")

    -- Already done?
    local pf = io.open(preview_path, "rb")
    if pf then pf:close(); return "CACHED" end

    local tmpfile = "/tmp/sgdb_static_" .. tostring(appid) .. "_" .. tostring(imagetype) .. ".bin"

    -- Step 1: synchronous download — identical to set_animated_artwork
    local dl = io.popen(string.format(
        "env -u LD_LIBRARY_PATH curl -s -L --max-time 120 --max-filesize 104857600 " ..
        "-H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64)' " ..
        "-H 'Referer: https://www.steamgriddb.com/' " ..
        "-w '%%{size_download}' -o %q %q 2>/dev/null",
        tmpfile, img_url
    ))
    if dl then dl:read("*a"); dl:close() end

    local sz = io.open(tmpfile, "rb")
    local fsize = sz and sz:seek("end") or 0
    if sz then sz:close() end
    if fsize == 0 then
        logger:error("set_static_artwork: download empty for " .. img_url)
        os.remove(tmpfile)
        return "FAILED"
    end
    logger:info(string.format("set_static_artwork: %d bytes, daemonising compress", fsize))

    -- Step 2: io.popen returns < 5 ms because webp_to_apng.py --static double-forks:
    --   parent closes stdout (pipe write-end) and exits → Lua gets EOF immediately.
    --   grandchild does PIL work in background and writes _preview.png.
    -- This is the same reliable pattern used by set_animated_artwork.
    local ph = io.popen(string.format(
        "env -u LD_LIBRARY_PATH python3 %q --static %q %q --imagetype=%d 2>/dev/null",
        PLUGIN_DIR .. "backend/webp_to_apng.py",
        tmpfile, cache_path, tonumber(imagetype) or 0
    ))
    if ph then ph:read("*a"); ph:close() end

    logger:info("set_static_artwork: io.popen returned, background compress running")
    return "CONVERTING"
end

local function on_load()
    logger:info("Backend loaded")
    -- Start local HTTP server serving the cache folder so Steam's browser can
    -- load animated APNGs directly. http_server.py self-daemonizes via double-fork.
    local http_script = os.getenv("HOME") .. "/.local/share/millennium/plugins/steam-easygrid/backend/http_server.py"
    os.execute(string.format("env -u LD_LIBRARY_PATH python3 %q %q 27331", http_script, CACHE_DIR))
    logger:info("HTTP cache server started on port 27331")
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
