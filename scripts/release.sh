#!/bin/bash

# Release script for macOS with code signing and notarization
# Loads credentials from .env.signing and builds for distribution

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env.signing"

# Check if .env.signing exists
if [ ! -f "$ENV_FILE" ]; then
    echo "Error: .env.signing file not found!"
    echo "Copy .env.signing.example to .env.signing and fill in your credentials."
    exit 1
fi

# Load environment variables from .env.signing
set -a
source "$ENV_FILE"
set +a

# Verify required variables are set
if [ -z "$APPLE_ID" ] || [ "$APPLE_ID" = "your@email.com" ]; then
    echo "Error: APPLE_ID not configured in .env.signing"
    exit 1
fi

if [ -z "$APPLE_APP_SPECIFIC_PASSWORD" ] || [ "$APPLE_APP_SPECIFIC_PASSWORD" = "xxxx-xxxx-xxxx-xxxx" ]; then
    echo "Error: APPLE_APP_SPECIFIC_PASSWORD not configured in .env.signing"
    exit 1
fi

if [ -z "$APPLE_TEAM_ID" ] || [ "$APPLE_TEAM_ID" = "XXXXXXXXXX" ]; then
    echo "Error: APPLE_TEAM_ID not configured in .env.signing"
    exit 1
fi

echo "Building Audio Broadcaster for macOS distribution..."
echo "Using Apple ID: $APPLE_ID"
echo "Team ID: $APPLE_TEAM_ID"
echo ""

cd "$PROJECT_DIR"
npm run build:mac
