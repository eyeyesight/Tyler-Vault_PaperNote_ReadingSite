import { spawn } from "node:child_process"

const child = spawn(process.execPath, process.argv.slice(2), {
  stdio: ["ignore", "inherit", "inherit"],
  windowsHide: true,
})

child.once("error", (error) => {
  console.error(`PARENT_SPAWN_ERROR: ${error.message}`)
  process.exitCode = 1
})
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})

console.log(`PARENT_CHILD_PID pid=${child.pid}`)
