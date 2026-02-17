# ── STAGE 1: BUILDER ─────────────────────────────────────────────────────────
# Alpine 3.21 chosen for minimal footprint (~5MB base).
# We compile from source to control exactly which libraries are linked.
# ─────────────────────────────────────────────────────────────────────────────
FROM alpine:3.21 AS builder

# Link to GitHub Repository for Package Visibility
LABEL org.opencontainers.image.source=https://github.com/maulik-mk/mp.ii-worker

# 1. Install Build Dependencies
# We only install what's strictly necessary for compilation.
# - build-base: GCC, Make, libc-dev (standard build toolchain)
# - pkgconf: Helper for library path resolution
# - nasm/yasm: Assemblers required for x264 SIMD optimizations (CRITICAL for perf)
# - x264-dev: H.264 video encoder headers
# - fdk-aac-dev: High-quality AAC audio encoder headers (better than native aac)
RUN apk add --no-cache \
    build-base \
    pkgconf \
    nasm \
    yasm \
    x264-dev \
    fdk-aac-dev

# 2. Download FFmpeg Source
ARG FFMPEG_VERSION=7.1
RUN wget -q https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.bz2 && \
    tar xjf ffmpeg-${FFMPEG_VERSION}.tar.bz2 && \
    rm ffmpeg-${FFMPEG_VERSION}.tar.bz2

WORKDIR /ffmpeg-${FFMPEG_VERSION}

# 3. Configure & Compile
# ONLY (H.264 + AAC).
#
# Flags explained:
# --enable-small: Optimize for size 
# --disable-network: Attack surface reduction.
# --disable-autodetect: Deterministic build.
# --disable-*: We strip all GUI dependencies (SDL, X11, XCB) and hardware accelerators
# --extra-cflags: "-O2" for standard optimization. "-march=armv8-a" matches target arch.
RUN ./configure \
    --prefix=/usr/local \
    --enable-gpl \
    --enable-nonfree \
    --enable-small \
    \
    # ── Core Capabilities ── \
    --enable-libx264 \
    --enable-libfdk-aac \
    \
    # ── Bloat Removal Strategy ── \
    --disable-doc \
    --disable-debug \
    --disable-ffplay \
    --disable-network \
    --disable-autodetect \
    \
    # ── GUI & System Dependencies Strip ── \
    --disable-sdl2 \
    --disable-libxcb \
    --disable-libxcb-shm \
    --disable-libxcb-xfixes \
    --disable-libxcb-shape \
    --disable-xlib \
    \
    # ── Hardware Acceleration Strip (CPU-only target) ── \
    --disable-vaapi \
    --disable-vdpau \
    --disable-videotoolbox \
    --disable-audiotoolbox \
    --disable-cuda \
    --disable-cuvid \
    --disable-nvenc \
    --disable-nvdec \
    \
    # ── Device Strip ── \
    --disable-indevs \
    --disable-outdevs \
    \
    # ── Compiler Optimizations ── \
    --extra-cflags="-O2" \
    \
    && make -j$(nproc) \
    && make install \
    # Binary Stripping: Removes debug symbols (~80% size reduction on binary)
    && strip /usr/local/bin/ffmpeg /usr/local/bin/ffprobe

# ── STAGE 2: RUNTIME ─────────────────────────────────────────────────────────
FROM alpine:3.21

# 1. Install Runtime Dependencies
# These are the shared libraries our compiled FFmpeg binary links against.
# Without these, the binary will fail with "not found" errors.
# - x264-libs: H.264 runtime
# - fdk-aac: AAC runtime
# - ca-certificates: Required we ever need to fetch HTTPS or HTTP
# clean apk cache immediately to keep layer size minimal.
RUN apk add --no-cache \
    x264-libs \
    fdk-aac \
    ca-certificates \
    && rm -rf /var/cache/apk/*

# 2. Copy Artifacts
# Bringing over ONLY the compiled binaries from Stage 1.
COPY --from=builder /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=builder /usr/local/bin/ffprobe /usr/local/bin/ffprobe

# 3. Security Hardening
# - Create specific directories for input/output to control scope.
# - Create a non-root 'ffmpeg' user/group.
# - Chown directories to this user.
# - Switch USER context.
# Ideally, we should run with read-only root filesystem if possible.
RUN mkdir -p /input /output && \
    addgroup -S ffmpeg && adduser -S ffmpeg -G ffmpeg && \
    chown -R ffmpeg:ffmpeg /input /output

USER ffmpeg
WORKDIR /work

# 4. Verification Step
# Fails the build immediately if the binary is broken/missing libs.
RUN ffmpeg -version && ffprobe -version

# Entrypoint configuration
# Allows passing arguments directly to docker run, e.g., "docker run img -i ..."
ENTRYPOINT ["ffmpeg"]
CMD ["-version"]
