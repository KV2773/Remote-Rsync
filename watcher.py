import os
import time
import sys

def RsyncCommand(ssh_id, aix_usr, aix_host, ssh_dir, rsync_cmd="~/.sshfs/command.txt"):
    cmd = f'rsync -avz -e "ssh -i {ssh_id}" {aix_usr}@{aix_host}:{rsync_cmd} {ssh_dir}'
    print(f"Executing command: {cmd}")
    os.system(cmd)

old_commnd = None

if __name__ == "__main__":
    # Correct argv indexing and default handling
    aix_usr = sys.argv[1] if len(sys.argv) > 1 else "root"
    aix_host = sys.argv[2] if len(sys.argv) > 2 else "ulsur.pok.stglabs.ibm.com"
    aix_isa_id = sys.argv[3] if len(sys.argv) > 3 else os.path.expanduser("~/.ssh/id_rsa_ulsur")
    ssh_dir = sys.argv[4] if len(sys.argv) > 4 else os.path.expanduser("~/.sshfs")

    print(f"Using AIX User: {aix_usr}, Host: {aix_host}, SSH ID: {aix_isa_id}, SSH Directory: {ssh_dir}")
    while True:
        RsyncCommand(aix_isa_id, aix_usr, aix_host, ssh_dir)

        if not os.path.exists("command.txt"):
            print("command.txt does not exist, waiting for next check...")
            time.sleep(5)
            continue

        # Future command execution logic (kept commented as in your code)
        # with open("command.txt", "r") as fp:
        #     new_command = fp.read().strip()
        #
        # if old_commnd != new_command:
        #     print(f"Executing command: {new_command}")
        #     old_commnd = new_command
        #     RsyncCommand(new_command)
        # else:
        #     print("No new command found in command.txt, waiting...")

        time.sleep(1)  # Short wait before checking again
