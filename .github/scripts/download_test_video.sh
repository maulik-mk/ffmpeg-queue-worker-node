#!/bin/bash
set -e

mkdir -p video
echo "Downloading sample video..."
curl -L -o video/test.mp4 https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_5MB.mp4
ls -lh video/