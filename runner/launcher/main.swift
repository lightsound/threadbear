// Threadbear Runner: the executable inside "Threadbear Runner.app", which
// the runner's LaunchAgent runs (scripts/install-runner.sh writes the
// plist, launcher/build-launcher.sh builds the app). It starts the command
// it is given, `node <home>/runner/launch.mjs`, as a child, forwards the
// signals launchd sends it, and exits with the child's exit code.
//
// Why an app at all: macOS asks about a protected folder (Desktop,
// Documents, Dropbox, ...) in the name of the *responsible process*, which
// for a launchd job is the job's own program, and every process it starts
// inherits it. When the plist ran node straight, every prompt an agent's
// shell caused said "node", and the grant went to that Node binary, so it
// was lost when Node updated. With this app as the program the prompts say
// "Threadbear Runner" and the grant stays with the app, which is rebuilt
// only when these sources change and is always signed the same way
// (build-launcher.sh), so it survives runner releases and Node updates.
//
// The child is spawned, not exec'd, so this process stays the responsible
// one. It stays in the launcher's process group, so launchd's cleanup when
// the job ends (AbandonProcessGroup is off) still reaches node and the
// agent CLIs under it, as it did before.
import Darwin
import Foundation

// The child's pid, read by the signal handlers. A signal that arrives
// before the child exists is kept and forwarded once it does.
nonisolated(unsafe) var childPid: pid_t = 0
nonisolated(unsafe) var pendingSignal: Int32 = 0

func log(_ level: String, _ message: String) {
  // launch.mjs's line format (and the runner's), since stderr is the
  // runner's log file.
  let at = ISO8601DateFormatter().string(from: Date())
  let line = "\(at) \(level) launcher: \(message)\n"
  line.withCString { _ = write(2, $0, strlen($0)) }
}

// The supervisor and installer run this mode out of a verified bundle.
// Consume the staging slot before exchanging, so the old bundle can never
// be mistaken for the staged update if the process stops after the exchange.
// `backup` is an empty directory reserved by the caller beside the app.
func replaceApp(_ incoming: String, _ installed: String, _ backup: String) -> Bool {
  if rename(incoming, backup) != 0 {
    log("ERROR", "could not prepare \(incoming): \(String(cString: strerror(errno)))")
    return false
  }

  // Check the bundle we actually claimed, in case staging replaced it
  // between the caller's signature check and the rename above.
  let verifier = Process()
  verifier.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
  verifier.arguments = ["--verify", backup]
  do {
    try verifier.run()
    verifier.waitUntilExit()
    if verifier.terminationStatus == 0 {
      // A normal rename fills an empty slot and refuses to overwrite a
      // non-empty directory. Exchange existing bundles at once.
      if rename(backup, installed) == 0 ||
        ((errno == ENOTEMPTY || errno == EEXIST) && renamex_np(backup, installed, UInt32(RENAME_SWAP)) == 0) {
        return true
      }
      log("ERROR", "could not exchange \(backup) with \(installed): \(String(cString: strerror(errno)))")
    }
  } catch {
    log("ERROR", "could not verify \(backup): \(error)")
  }

  // Leave an ordinary failure staged for retry. If a newer stage is
  // already there, keep this bundle out of its way at the backup path.
  _ = rename(backup, incoming)
  return false
}

let arguments = CommandLine.arguments
if arguments.count == 5 && arguments[1] == "--replace-app" {
  exit(replaceApp(arguments[2], arguments[3], arguments[4]) ? 0 : 1)
}
if arguments.count < 2 {
  log("ERROR", "nothing to run. Threadbear Runner is started by launchd (com.mikerosoft.threadbear.runner) with the runner's command as its arguments; install it with runner/scripts/install-runner.sh rather than opening it.")
  exit(64)
}
let command = Array(arguments.dropFirst())

// Forwarded, not handled: the child decides what to do with them (launch.mjs
// stops its runners on SIGTERM, SIGINT and SIGHUP).
for sig in [SIGTERM, SIGINT, SIGHUP, SIGUSR1, SIGUSR2] {
  signal(sig) { sig in
    if childPid > 0 {
      kill(childPid, sig)
    } else {
      pendingSignal = sig
    }
  }
}

var argv: [UnsafeMutablePointer<CChar>?] = command.map { strdup($0) }
argv.append(nil)
var attrs: posix_spawnattr_t? = nil
posix_spawnattr_init(&attrs)
// Our handlers aren't inherited across exec anyway; this also hands the
// child the default dispositions for everything, whatever launchd gave us.
var all = sigset_t()
sigfillset(&all)
posix_spawnattr_setsigdefault(&attrs, &all)
posix_spawnattr_setflags(&attrs, Int16(POSIX_SPAWN_SETSIGDEF))

var pid: pid_t = 0
let rc = posix_spawnp(&pid, command[0], nil, &attrs, argv, environ)
posix_spawnattr_destroy(&attrs)
if rc != 0 {
  log("ERROR", "could not start \(command[0]): \(String(cString: strerror(rc)))")
  // 127 as a shell does for a command that can't be run; launchd starts
  // the job again after its ThrottleInterval, as for any failed start.
  exit(127)
}
childPid = pid
log("INFO", "started \(command.joined(separator: " ")) (pid \(pid))")
if pendingSignal != 0 {
  kill(pid, pendingSignal)
}

var status: Int32 = 0
while waitpid(pid, &status, 0) == -1 {
  if errno != EINTR {
    log("ERROR", "waitpid failed: \(String(cString: strerror(errno)))")
    exit(1)
  }
}
// WIFEXITED / WEXITSTATUS / WTERMSIG by hand: the macros don't come
// through to Swift.
if status & 0x7f == 0 {
  exit((status >> 8) & 0xff)
}
let terminated = status & 0x7f
log("INFO", "the runner was stopped by signal \(terminated)")
// The shell's convention for a child killed by a signal.
exit(128 + terminated)
