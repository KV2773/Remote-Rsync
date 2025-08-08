#!/usr/bin/expect -f

# Usage: ./ssh-copy-id-expect.sh <user@host> <path_to_key> <password>

set userHost [lindex $argv 0]
set keyPath [lindex $argv 1]
set password [lindex $argv 2]

spawn ssh-copy-id -f -i $keyPath $userHost

expect {
    -re "(?i)yes/no" {
        send "yes\r"
        exp_continue
    }
    
    -re ".*'s password: *$" {
        send "$password\r"
    }

     eof {
        # No prompt appeared; probably key already installed
    }
}

spawn ssh -o StrictHostKeyChecking=no -i $keyPath $userHost "echo 'SSH key installed successfully.'"
expect {
    -re "*"SSH key installed successfully.*" {
        send_user "SSH key installed successfully.\n"
    }
    eof {
        send_user "Failed to install SSH key.\n"
        exit 1
    }
    }