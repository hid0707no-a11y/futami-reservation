#!/bin/sh
# 初回 clone 後に 1 度だけ実行して hooks を有効化する
# 使い方:
#   cd /path/to/futami-reservation
#   ./hooks/install.sh
#
# 内部的には `git config core.hooksPath hooks` を実行するだけ。
# これで `hooks/pre-commit` が commit 時に自動実行されるようになる。

set -e

git config core.hooksPath hooks
chmod +x hooks/pre-commit
echo "✅ hooks installed. core.hooksPath = $(git config core.hooksPath)"
