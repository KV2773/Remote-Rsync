import os
import time
import sys


def RsyncCommand(ssh_id,aix_usr, aix_host,ssh_dir,rsync_cmd="~/.sshfs/command.txt"):
    cmd = f'rsync -avz -e "ssh -i {ssh_id}" {aix_usr}@{aix_host}:{rsync_cmd} ${ssh_dir}'
    print(f"Executing command: {cmd}")
    os.system(cmd)


old_commnd = None



if __name__ == "__main__":
    aix_usr = sys.argv[0] if len(sys.argv) > 1 else "root"
    # aix_host = "pokndd5.pok.stglabs.ibm.com"
    aix_host = sys.argv[1] if len(sys.argv) > 2 else "ulsur.pok.stglabs.ibm.com"

    aix_isa_id = sys.argv[2] if len(sys.argv) > 3 else "id_rsa_ulsur"

    ssh_dir = sys.argv[3] if len(sys.argv) > 4 else os.path.expanduser("~/.sshfs")

    while True:
        RsyncCommand(aix_isa_id, aix_usr, aix_host,ssh_dir)

        
        if not os.path.exists("command.txt"):
            print("command.txt does not exist, waiting for next check...")
            time.sleep(5)
            continue
        # fp = open("command.txt", "r")
        
        # new_command = fp.read().strip()
        # fp.close()

        # if old_commnd != new_command:
        #     print(f"Executing command: {new_command}")
        #     old_commnd = new_command
        #     RsyncCommand(new_command)
        # else:
        #     print("No command found in command.txt, waiting for next check...")
        time.sleep(1)  # Wait for 5 seconds before checking again
