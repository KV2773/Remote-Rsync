code() {
    FILE="$1"

    # If it's not an absolute path, expand it relative to the current working dir
    case "$FILE" in
        /*) ABS="$FILE" ;;  # already absolute
        *)  ABS="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")" ;;
    esac

    : > ~/.sshfs/command.txt
    echo "$ABS" >> ~/.sshfs/command.txt
}