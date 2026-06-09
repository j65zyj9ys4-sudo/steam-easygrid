#!/usr/bin/env python3
import sys
import os
from PIL import Image

def convert(input_path, output_path):
    img = Image.open(input_path)
    frames = []
    durations = []

    try:
        while True:
            frames.append(img.copy().convert("RGBA"))
            durations.append(img.info.get("duration", 100))
            img.seek(img.tell() + 1)
    except EOFError:
        pass

    total = len(frames)
    if total <= 1:
        print("NOT_ANIMATED")
        sys.exit(1)

    # Save first frame as preview for SetCustomArtworkForApp instant display
    preview_path = output_path.replace(".png", "_preview.png")
    frames[0].save(preview_path, format="PNG", optimize=True)

    print(f"PROGRESS:0/{total}", flush=True)

    # Write to temp path first, atomic rename when complete
    tmp_path = output_path + ".tmp"
    frames[0].save(
        tmp_path,
        save_all=True,
        append_images=frames[1:],
        loop=0,
        duration=durations,
        format="PNG"
    )
    print(f"PROGRESS:{total}/{total}", flush=True)

    os.rename(tmp_path, output_path)
    print(f"SUCCESS:{total}")

def compress_static(input_path, output_path, imagetype=0):
    """Cache a static PNG/JPG and produce an IPC-safe preview thumbnail.

    The full-quality file is copied byte-for-byte (shutil.copy2) — no
    re-encoding, so it's instant regardless of image size.  PIL is used
    only to decode + resize a small thumbnail for the IPC preview, which
    is the step that was previously slow (optimize=True on a full PNG can
    take 5-10 s on large images).
    """
    import shutil

    # Fast copy — original quality preserved, no encode overhead
    shutil.copy2(input_path, output_path)

    # Open just to build the thumbnail (PIL still decodes, but doesn't re-encode full res)
    img = Image.open(input_path)
    if img.mode == 'P':
        img = img.convert('RGBA')

    max_dims = {0: (400, 600), 1: (960, 310), 2: (400, 200), 3: (320, 150), 4: (128, 128)}
    max_w, max_h = max_dims.get(imagetype, (400, 600))

    preview = img.copy()
    preview.thumbnail((max_w, max_h), Image.LANCZOS)

    preview_path = output_path.replace('.png', '_preview.png')
    if imagetype == 2 and img.mode == 'RGBA':
        # Logos: keep alpha, use PNG (no optimize so it's fast)
        preview.save(preview_path, 'PNG', optimize=False)
    else:
        if preview.mode in ('RGBA', 'LA', 'P'):
            preview = preview.convert('RGB')
        preview.save(preview_path, 'JPEG', quality=85)

    preview_size = os.path.getsize(preview_path)
    print(f"STATIC_READY:{output_path}:{preview_size}", flush=True)


if __name__ == "__main__":
    # ── Static mode ──────────────────────────────────────────────────────────────
    # webp_to_apng.py --static <input> <output> [--imagetype=N]
    #
    # Why double-fork?  os.execute("nohup bash -c 'python3 --static ...' &") and
    # every variant of it blocks in Millennium's Lua for 14+ seconds because the
    # background bash shell inherits Millennium's open pipe file descriptors, which
    # keeps the pipe write-end alive until the shell's child (python3) eventually
    # exits.  The double-fork pattern fixes this by:
    #   1. Parent (what Lua's io.popen sees) forks First-child and waits for it.
    #   2. First-child closes fd 1 (pipe write-end) BEFORE forking Grandchild.
    #      Grandchild never inherits the pipe write-end.
    #   3. First-child exits → Parent's waitpid() returns → Parent exits.
    #   4. Lua's io.popen:read("*a") gets EOF almost immediately (< 5 ms).
    #   5. Lua returns "CONVERTING" right away; JS shows CONVERTING… and polls.
    #   6. Grandchild does PIL work (~1-3 s) and writes _preview.png.
    #   7. check_artwork_ready() polling finds the preview → applies artwork.
    if '--static' in sys.argv:
        args = [a for a in sys.argv[1:] if not a.startswith('--')]
        imagetype = 0
        for a in sys.argv:
            if a.startswith('--imagetype='):
                imagetype = int(a.split('=')[1])
        if len(args) < 2:
            print("Usage: webp_to_apng.py --static <input> <output> [--imagetype=N]")
            sys.exit(1)

        input_path, output_path = args[0], args[1]

        # ── Fork 1 ────────────────────────────────────────────────────────────
        pid = os.fork()
        if pid > 0:
            # Original process: reap first-child (exits near-instantly), then exit.
            # io.popen in Lua sees EOF when we exit here.
            os.waitpid(pid, 0)
            sys.exit(0)

        # ── First-child ───────────────────────────────────────────────────────
        # Close stdout NOW so the grandchild never inherits the pipe write-end.
        try:
            os.close(1)
        except OSError:
            pass
        os.setsid()  # Detach from controlling terminal / process group

        # ── Fork 2 ────────────────────────────────────────────────────────────
        pid2 = os.fork()
        if pid2 > 0:
            sys.exit(0)  # First-child exits; grandchild continues

        # ── Grandchild ────────────────────────────────────────────────────────
        # stdout is already closed; do PIL work silently.
        try:
            compress_static(input_path, output_path, imagetype)
        except Exception as e:
            try:
                with open('/tmp/sgdb_static_error.log', 'w') as f:
                    import traceback
                    traceback.print_exc(file=f)
            except Exception:
                pass
        sys.exit(0)

    # ── Animated / default mode ───────────────────────────────────────────────
    if len(sys.argv) != 3:
        print("Usage: webp_to_apng.py <input> <output>")
        sys.exit(1)
    convert(sys.argv[1], sys.argv[2])
