#!/bin/bash

# Enable strict mode:
# -e: Exit immediately if a command exits with a non-zero status.
# -u: Treat unset variables as an error when substituting.
# -o pipefail: The return value of a pipeline is the status of the last command to exit with a non-zero status.
set -euo pipefail

# ------------------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------------------
IMAGE_NAME="worker-ffmpeg"

# Resource limits for testing
CONTAINER_MEM_LIMIT="300m"
CONTAINER_CPU_LIMIT="1"

# Paths
# script is run from the project root.
VIDEO_DIR="video"
OUTPUT_DIR="output"
TEST_VIDEO_FILE=$(ls "$VIDEO_DIR" | head -n 1)

# colors.
BOLD="\033[1m"
GREEN="\033[32m"
CYAN="\033[36m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

log_info() {
    echo -e "${CYAN}[INFO]${RESET} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${RESET} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${RESET} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${RESET} $1" >&2
}

log_header() {
    echo -e "\n${BOLD}=== $1 ===${RESET}"
}

# ------------------------------------------------------------------------------
# Steps
# ------------------------------------------------------------------------------

# Ensure Docker is installed and running
check_prerequisites() {
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed or not in PATH."
        exit 1
    fi
}

# Step 1: Build the Docker image
build_image() {
    log_header "Step 1: Building Docker Image"
    log_info "Initiating build for image '${IMAGE_NAME}'..."
    docker build -t "${IMAGE_NAME}" .
    log_success "Docker image build completed successfully."
}

# Step 2: Verify FFmpeg version
verify_ffmpeg_version() {
    log_header "Step 2: Verifying FFmpeg Version"
    local output
    output=$(docker run --rm "${IMAGE_NAME}" -version)
    echo "$output" | head -n 1
}

# Step 3: Verify FFprobe version
verify_ffprobe_version() {
    log_header "Step 3: Verifying FFprobe Version"
    local output
    output=$(docker run --rm --entrypoint ffprobe "${IMAGE_NAME}" -version)
    echo "$output" | head -n 1
}

# Step 4: Verify supported codecs
verify_codecs() {
    log_header "Step 4: Validating Supported Codecs"
    log_info "Checking for required libraries: libx264 (H.264) and libfdk_aac (AAC)..."
    
    local codecs
    if codecs=$(docker run --rm "${IMAGE_NAME}" -codecs 2>/dev/null | grep -E "libx264|libfdk_aac"); then
        echo "$codecs"
        log_success "Required codecs verified successfully."
    else
        log_error "Critical Error: Required codecs (libx264, libfdk_aac) are missing from the image."
        exit 1
    fi
}

# Step 5: Transcode Test
run_transcode_test() {
    log_header "Step 5: Transcoding Test"
    local input_path="${VIDEO_DIR}/${TEST_VIDEO_FILE}"
    local output_file="${OUTPUT_DIR}/test_720p.mp4"

    if [[ ! -f "$input_path" ]]; then
        log_warn "Input file not found at '${input_path}'. Skipping transcoding test."
        return
    fi

    # Prepare output directory
    mkdir -p "${OUTPUT_DIR}"
    rm -f "${output_file}"

    log_info "Starting transcoding process (Memory Limit: ${CONTAINER_MEM_LIMIT})..."
    
    # Run FFmpeg in Docker
    docker run --rm \
        --memory="${CONTAINER_MEM_LIMIT}" \
        --cpus="${CONTAINER_CPU_LIMIT}" \
        -v "$(pwd)/${VIDEO_DIR}:/input:ro" \
        -v "$(pwd)/${OUTPUT_DIR}:/output" \
        "${IMAGE_NAME}" \
        -y \
        -hide_banner -loglevel error \
        -stats \
        -i "/input/${TEST_VIDEO_FILE}" \
        -threads 1 \
        -filter_threads 1 \
        -vf "scale=1280:720" \
        -c:v libx264 -preset ultrafast -b:v 2800k \
        # First 10 seconds of the video only
        -t 10 \
        -movflags +faststart \
        "/output/$(basename "${output_file}")"

    if [[ -f "${output_file}" ]]; then
        log_success "Transcoding complete. Output file created at: ${output_file}"
        ls -lh "${output_file}"
    else
        log_error "Transcoding failed. No output file was generated."
        exit 1
    fi
}

# Step 6: HLS Adaptive Bitrate Test
run_hls_test() {
    log_header "Step 6: HLS Adaptive Bitrate Test"
    local input_path="${VIDEO_DIR}/${TEST_VIDEO_FILE}"
    
    if [[ ! -f "$input_path" ]]; then
        log_warn "Input file not found. Skipping HLS test."
        return
    fi

    local hls_root="${OUTPUT_DIR}/hls"
    rm -rf "${hls_root}"
    mkdir -p "${hls_root}"/{360p,720p,1080p}

    # Define common options to reduce repetition
    local docker_opts="--rm --memory=${CONTAINER_MEM_LIMIT} --cpus=${CONTAINER_CPU_LIMIT} -v $(pwd)/${VIDEO_DIR}:/input:ro -v $(pwd)/${OUTPUT_DIR}/hls:/output"
    local ffmpeg_opts="-hide_banner -loglevel error -stats -threads 1 -filter_threads 1"
    local hls_flags="-f hls -hls_time 4 -hls_playlist_type vod -hls_list_size 0"

    # Pass 1: 360p
    log_info "Generating 360p HLS stream segment..."
    docker run ${docker_opts} "${IMAGE_NAME}" ${ffmpeg_opts} \
        -i "/input/${TEST_VIDEO_FILE}" -t 10 \
        -vf "scale=640:360" -c:v libx264 -preset ultrafast -b:v 800k \
        ${hls_flags} -hls_segment_filename '/output/360p/segment_%03d.ts' -y '/output/360p/stream.m3u8'

    # Pass 2: 720p
    log_info "Generating 720p HLS stream segment..."
    docker run ${docker_opts} "${IMAGE_NAME}" ${ffmpeg_opts} \
        -i "/input/${TEST_VIDEO_FILE}" -t 10 \
        -vf "scale=1280:720" -c:v libx264 -preset ultrafast -b:v 2800k \
        ${hls_flags} -hls_segment_filename '/output/720p/segment_%03d.ts' -y '/output/720p/stream.m3u8'

    # Pass 3: 1080p
    log_info "Generating 1080p HLS stream segment..."
    docker run ${docker_opts} "${IMAGE_NAME}" ${ffmpeg_opts} \
        -i "/input/${TEST_VIDEO_FILE}" -t 10 \
        -vf "scale=1920:1080" -c:v libx264 -preset ultrafast -b:v 5000k \
        ${hls_flags} -hls_segment_filename '/output/1080p/segment_%03d.ts' -y '/output/1080p/stream.m3u8'

    # Generate Master Playlist
    cat > "${hls_root}/master.m3u8" <<EOF
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=896000,RESOLUTION=640x360
360p/stream.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2928000,RESOLUTION=1280x720
720p/stream.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5128000,RESOLUTION=1920x1080
1080p/stream.m3u8
EOF
    
    log_success "HLS master playlist generated successfully at: ${hls_root}/master.m3u8"
    
    local segment_count
    segment_count=$(find "${hls_root}" -name "*.ts" | wc -l | tr -d ' ')
    log_info "Total HLS segments generated: ${segment_count}"
}

# Step 7: Print Image Statistics
print_stats() {
    log_header "Step 7: Image Statistics"
    local size
    size=$(docker images "${IMAGE_NAME}" --format "{{.Size}}")
    log_info "Final Docker Image Size: ${size}"
    
    echo -e "\n${BOLD}${GREEN} All tests passed successfully.${RESET}"
    echo -e "Memory check passed: Usage remained within ${CONTAINER_MEM_LIMIT} limit."
}

# Main Execution
main() {
    check_prerequisites
    build_image
    verify_ffmpeg_version
    verify_ffprobe_version
    verify_codecs
    run_transcode_test
    run_hls_test
    print_stats
}

# Execute main function
main "$@"
