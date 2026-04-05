# =============================================================================
# PROJECT: FFmpeg Video Processing Worker (Node.js)
# AUTHOR: Maulik M. Kadeval
#
# COPYRIGHT & THIRD-PARTY ATTRIBUTIONS:
# This image compiles and integrates several high-performance media libraries. 
# The respective trademarks, copyrights, and licenses belong to their original 
# creators and organizations:
#
# * FFmpeg     - Copyright (c) The FFmpeg Developers (https://ffmpeg.org)
# * VMAF       - Copyright (c) Netflix, Inc. (https://github.com/Netflix/vmaf)
# * libfdk-aac - Copyright (c) Fraunhofer IIS (https://www.iis.fraunhofer.de)
# * libx264    - Copyright (c) VideoLAN Organization (https://www.videolan.org)
# * libx265    - Copyright (c) MulticoreWare, Inc. (https://x265.com)
# * libopus    - Copyright (c) Xiph.Org Foundation (https://opus-codec.org)
# * libsoxr    - Copyright (c) The SoX Resampler Authors (https://sourceforge.net/p/soxr)
# * libzimg    - Copyright (c) Sekrit-Twc (https://github.com/sekrit-twc/zimg)
#
# NOTE: This build enables `--nonfree` components (libfdk-aac). Ensure compliance 
# with licensing requirements if distributing this image commercially.
#
# Base Image: Ubuntu 24.04 (Noble Numbat, glibc 2.39).
# =============================================================================

FROM ubuntu:24.04 AS builder

# Suppress interactive prompts from apt during the build process
ENV DEBIAN_FRONTEND=noninteractive

# -----------------------------------------------------------------------------
# 1. Install System & Build Dependencies
# Retrieves compilation toolchains (GCC, Make, CMake, Meson) and development 
# headers for the third-party audio/video codecs.
# -----------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    software-properties-common && \
    add-apt-repository -y universe && \
    add-apt-repository -y multiverse && \
    apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    pkg-config \
    nasm \
    yasm \
    wget \
    git \
    cmake \
    ninja-build \
    meson \
    ca-certificates \
    libx264-dev \
    libx265-dev \
    libfdk-aac-dev \
    libzimg-dev \
    libssl-dev \
    libsoxr-dev \
    libopus-dev \
    && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# 2. Compile Netflix VMAF (Video Multi-Method Assessment Fusion)
# Clones the official Netflix repository and builds the libvmaf library for 
# AI-driven perceptual video quality metrics.
# -----------------------------------------------------------------------------
RUN git clone --depth 1 https://github.com/Netflix/vmaf.git /tmp/vmaf && \
    cd /tmp/vmaf/libvmaf && \
    meson setup build --buildtype release --prefix=/usr/local && \
    ninja -vC build install && \
    mkdir -p /usr/local/share/model && \
    cp -r ../model/* /usr/local/share/model/ && \
    rm -rf /tmp/vmaf

# -----------------------------------------------------------------------------
# 3. Download FFmpeg Source Code
# -----------------------------------------------------------------------------
ARG FFMPEG_VERSION=7.1
RUN wget -q https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.bz2 && \
    tar xjf ffmpeg-${FFMPEG_VERSION}.tar.bz2 && \
    rm ffmpeg-${FFMPEG_VERSION}.tar.bz2

WORKDIR /ffmpeg-${FFMPEG_VERSION}

# -----------------------------------------------------------------------------
# 4. Configure and Compile FFmpeg
# Integrates all previously installed libraries (x264, x265, VMAF, Opus, SoXR).
# PKG_CONFIG_PATH ensures the custom-built libvmaf is located successfully.
# -----------------------------------------------------------------------------
RUN PKG_CONFIG_PATH=/usr/local/lib/aarch64-linux-gnu/pkgconfig:/usr/local/lib/x86_64-linux-gnu/pkgconfig:/usr/local/lib/pkgconfig \
    ./configure \
    --prefix=/usr/local \
    --enable-gpl \
    --enable-nonfree \
    --enable-version3 \
    --enable-swresample \
    --enable-libsoxr \
    --enable-libopus \
    --enable-libx264 \
    --enable-libx265 \
    --enable-libfdk-aac \
    --enable-libzimg \
    --enable-libvmaf \
    --enable-encoder=eac3 \
    --enable-encoder=ac3 \
    --enable-encoder=aac \
    --enable-openssl \
    --enable-protocol=https \
    --enable-protocol=http \
    --enable-protocol=file \
    --disable-doc \
    --disable-debug \
    --disable-ffplay \
    --disable-autodetect \
    --disable-sdl2 \
    --disable-libxcb \
    --disable-libxcb-shm \
    --disable-libxcb-xfixes \
    --disable-libxcb-shape \
    --disable-xlib \
    --disable-vaapi \
    --disable-vdpau \
    --disable-videotoolbox \
    --disable-audiotoolbox \
    --disable-cuda \
    --disable-cuvid \
    --disable-nvenc \
    --disable-nvdec \
    --disable-indevs \
    --disable-outdevs \
    --extra-cflags="-O2" \
    && make -j$(nproc) \
    && make install \
    && strip /usr/local/bin/ffmpeg /usr/local/bin/ffprobe


# =============================================================================
# Stage 2 — Node.js Application Build
# Securely installs Node.js and compiles the TypeScript worker codebase.
# =============================================================================
FROM ubuntu:24.04 AS node-builder

ENV DEBIAN_FRONTEND=noninteractive

# Securely install NodeSource repository and pnpm package manager
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    NODE_MAJOR=24 && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && apt-get install -y --no-install-recommends nodejs && \
    npm install -g pnpm && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build


# =============================================================================
# Stage 3 — Production Runtime
# Final optimized image containing the compiled Node.js application, the custom 
# FFmpeg binary, and minimal shared runtime libraries.
# =============================================================================
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# -----------------------------------------------------------------------------
# Metadata & OCI Labels
# -----------------------------------------------------------------------------
ARG VERSION=0.3.0
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="ffmpeg-queue-worker-node" \
      org.opencontainers.image.description="FFmpeg 7.1 (w/ VMAF) & Node.js Video Job Worker" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.authors="Maulik M. Kadeval" \
      org.opencontainers.image.source="https://github.com/maulik-mk/ffmpeg-queue-worker-node.git" \
      com.bitflow.project.code="P1/25-26/bd/A1-WK" \
      com.bitflow.project.id="P1" \
      com.bitflow.project.cycle="25-26" \
      com.bitflow.project.dept="bd" \
      com.bitflow.project.app="A1" \
      com.bitflow.project.role="WK"

# -----------------------------------------------------------------------------
# 1. Install Runtime Dependencies & Node.js
# Fetches the shared objects (.so files) required by the compiled FFmpeg binary.
# -----------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    ca-certificates \
    gnupg \
    libx265-199 \
    libx264-164 \
    libfdk-aac2 \
    libzimg2 \
    libsoxr0 \
    libopus0 \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && NODE_MAJOR=24 \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update && apt-get install -y --no-install-recommends nodejs \
    && npm install -g pnpm \
    && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# 2. Transfer FFmpeg & VMAF Assets from Builder Stage
# -----------------------------------------------------------------------------
COPY --from=builder /usr/local/bin/ffmpeg  /usr/local/bin/ffmpeg
COPY --from=builder /usr/local/bin/ffprobe /usr/local/bin/ffprobe
COPY --from=builder /usr/local/lib/*-linux-gnu/libvmaf.so* /usr/local/lib/
COPY --from=builder /usr/local/share/model /usr/local/share/model

# Update the dynamic linker cache so FFmpeg locates libvmaf and system libraries
RUN ldconfig

# -----------------------------------------------------------------------------
# 3. Setup Node.js Application Environment
# -----------------------------------------------------------------------------
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=node-builder /app/dist ./dist

# -----------------------------------------------------------------------------
# 4. Security Hardening & Process Management
# Creates a non-root 'worker' user to safely execute the application.
# -----------------------------------------------------------------------------
RUN mkdir -p /tmp/worker && \
    groupadd -r worker && useradd -r -g worker worker && \
    chown -R worker:worker /app /tmp/worker

USER worker

ENV NODE_ENV=production
ENV PORT=3000

# Docker Healthcheck to ensure the Node.js API/Worker is responding
HEALTHCHECK --interval=30s --timeout=3s \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/server.js"]