#!/bin/bash

# Exit on error
set -e

echo "Starting build process for Everything Markdown..."

echo "Cleaning up system caches and development artifacts..."
find . -name '.DS_Store' -type f -delete
rm -rf "$(dirname "$0")/Firefox/web-ext-artifacts"

# Navigate to the Firefox extension directory
cd "$(dirname "$0")/Firefox"

echo "Running web-ext lint..."
npx web-ext lint

echo "Running web-ext build..."
npx web-ext build

echo "Build complete! Artifacts are located in the Firefox/web-ext-artifacts/ directory."
