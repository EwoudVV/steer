#!/bin/sh
# installs steer (https://github.com/EwoudVV/steer) into ~/.steer/bin and sets it up
#   curl -fsSL https://steer.duck.hackclub.app/install.sh | sh
set -eu

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) file=steer-macos-arm64 ;;
  Darwin-x86_64) file=steer-macos-x64 ;;
  Linux-x86_64) file=steer-linux-x64 ;;
  Linux-aarch64 | Linux-arm64) file=steer-linux-arm64 ;;
  *)
    echo "steer doesnt have a build for $(uname -s) $(uname -m) yet"
    exit 1
    ;;
esac

bin="$HOME/.steer/bin"
mkdir -p "$bin"
echo "downloading steer..."
curl -fsSL "https://github.com/EwoudVV/steer/releases/latest/download/$file" -o "$bin/steer.new"
chmod +x "$bin/steer.new"
mv "$bin/steer.new" "$bin/steer"
echo

# where this script was downloaded from, so steer signs in there too. steer.dino.icu
# hands out this script with its own address here.
export STEER_SERVER=https://steer.duck.hackclub.app

# steer install explains what it does and asks first. this script is piped into sh,
# so the answer has to come from the terminal.
if (: < /dev/tty) 2>/dev/null; then
  "$bin/steer" install < /dev/tty
else
  "$bin/steer" install --yes
fi
