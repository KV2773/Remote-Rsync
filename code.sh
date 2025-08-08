 code() {
        FILE="$1"
        # Expand relative path using shell before passing to Python
        FILE="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
        : > ~/.sshfs/command.txt
        echo "$FILE" >> ~/.sshfs/command.txt
    }