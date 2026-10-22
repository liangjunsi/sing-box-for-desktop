import Foundation
import Darwin
let args = CommandLine.arguments
if args.count != 4 { exit(2) }
let child = Process()
child.executableURL = URL(fileURLWithPath: args[1])
child.arguments = ["run", "--working-directory", args[2], "--socket", args[3]]
child.standardOutput = FileHandle.standardError
child.standardError = FileHandle.standardError
child.standardInput = FileHandle.nullDevice
let parentPipe = FileHandle.standardInput
do {
    try child.run()
DispatchQueue.global().async {
    _ = parentPipe.readDataToEndOfFile()
    if child.isRunning { child.terminate() }
}

    child.waitUntilExit()
    exit(child.terminationStatus)
} catch {
    FileHandle.standardError.write(Data("daemon launch failed: \(error)\n".utf8)); exit(1)
}
