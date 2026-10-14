#!/usr/bin/env python3
"""Run selected Paperclip qualification inside a closed disposable namespace."""
import argparse, hashlib, json, os, re, subprocess, tempfile, time, uuid
from pathlib import Path
from datetime import datetime, timezone

REPO = Path(__file__).resolve().parent.parent
NODE = Path("/usr/local/bin/node").resolve(strict=True)
EVIDENCE = Path("/home/dimz/dd-ops/agent-architecture-2026-10-11/paperclip-bridge-2026-10-14")

def pins():
    return {str(p.relative_to(REPO)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted((REPO / "dom430-bridge").glob("*")) if p.is_file()}

NEGATIVE_CONTROLS = {'contained-authority': ('dom430-bridge/adapter.ts', "if (last.contained && last.state !== 'running')", "if (last.state !== 'running')", 'cannot return a successful complete worker without containment'), 'deadline-consistency': ('dom430-bridge/adapter.ts', 'last.budget.deadlineMs !== original.deadline', 'false', 'rejects an allocation reset of deadlineMs')}

TYPECHECK_CONFIG = 'dom430-bridge/tsconfig.narrow.json'
TYPECHECK_ENTRIES = ['dom430-bridge/adapter.ts', 'dom430-bridge/adapter.test.ts']

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--typecheck", action="store_true")
    parser.add_argument("--select", nargs="*")
    parser.add_argument("--pattern")
    parser.add_argument("--timeout-probe", action="store_true")
    parser.add_argument("--negative-control", choices=list(NEGATIVE_CONTROLS))
    args = parser.parse_args()
    if args.report.resolve().parent != EVIDENCE:
        raise SystemExit("report must be in owned trial folder")
    if args.typecheck and (args.negative_control or args.probe or args.timeout_probe or args.pattern or args.select):
        raise SystemExit("typecheck cannot be combined with test or probe selectors")
    if args.negative_control and (args.probe or args.timeout_probe or args.pattern or args.select):
        raise SystemExit("guard removal owns its fixed case selector")
    before = pins()
    started = datetime.now(timezone.utc).isoformat()
    unit = "dom430-paperclip-" + uuid.uuid4().hex[:12]
    with tempfile.TemporaryDirectory(prefix="dd-paperclip-contained-") as temporary:
        private = Path(temporary)
        (private / "passwd").write_text("worker:x:1000:1000::/home/worker:/bin/sh\n")
        (private / "group").write_text("worker:x:1000:\n")
        (private / "hosts").write_text("127.0.0.1 localhost\n")
        cache = private / "cache"; cache.mkdir()
        cache_target = (REPO / "node_modules/.vite-temp").resolve(); cache_target.mkdir(exist_ok=True)
        observation_file = private / "authority-observations.jsonl"; observation_file.touch()
        overlay = None
        if args.negative_control:
            mutation_path, target, replacement, expected_name = NEGATIVE_CONTROLS[args.negative_control]
            original = (REPO / mutation_path).read_text()
            if original.count(target) != 1: raise SystemExit("negative control target count differs")
            overlay = private / ("mutant" + Path(mutation_path).suffix); overlay.write_text(original.replace(target, replacement))
            args.select = ["dom430-bridge/adapter.test.ts"]; args.pattern = re.escape(expected_name)
        command = ["/usr/bin/bwrap", "--unshare-all", "--new-session", "--die-with-parent",
                   "--uid", "1000", "--gid", "1000", "--hostname", "dom430-paperclip-lab",
                   "--clearenv", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev",
                   "--size", "1073741824", "--tmpfs", "/tmp", "--dir", "/home/worker", "--dir", "/etc",
                   "--ro-bind", str(private / "passwd"), "/etc/passwd", "--ro-bind", str(private / "group"), "/etc/group",
                   "--ro-bind", str(private / "hosts"), "/etc/hosts", "--ro-bind", "/home/dimz/dd-ops/dom-430-paperclip-lab", "/home/dimz/dd-ops/dom-430-paperclip-lab", "--ro-bind", str(REPO), str(REPO),
                   "--bind", str(cache), str(cache_target), "--ro-bind", str(NODE), "/runtime/node", "--chdir", str(REPO)]
        command += ["--bind", str(observation_file), "/tmp/dom430-authority-observations.jsonl"]
        if overlay: command += ["--ro-bind", str(overlay), str(REPO / mutation_path)]
        for location in ("/lib", "/lib64", "/etc/ld.so.cache"):
            if Path(location).exists(): command += ["--ro-bind", location, location]
        environment = {"HOME": "/home/worker", "USER": "worker", "LOGNAME": "worker", "PATH": "/usr/local/bin:/usr/bin:/bin",
                       "TMPDIR": "/tmp", "PAPERCLIP_HOME": "/tmp/paperclip-private", "PAPERCLIP_TELEMETRY_DISABLED": "1",
                       "DO_NOT_TRACK": "1", "CI": "1", "NODE_ENV": "production", "PAPERCLIP_LOG_LEVEL": "silent",
                       "PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK": "true",
                       "DOM430_HOST_NET_NS": os.readlink("/proc/self/ns/net"),
                       "DOM430_AUTHORITY_OBSERVATIONS_FILE": "/tmp/dom430-authority-observations.jsonl"}
        for name, value in environment.items(): command += ["--setenv", name, value]
        if args.typecheck:
            command += ["--", "/runtime/node", "node_modules/typescript/bin/tsc", "--project", TYPECHECK_CONFIG, "--noEmit", "--pretty", "false", "--listFiles"]
        elif args.probe or args.timeout_probe:
            code = "const fs=require('fs'); console.log(JSON.stringify({privateHome:process.env.HOME,personalAbsent:!fs.existsSync('/home/dimz/.codex'),networkNamespace:fs.readlinkSync('/proc/self/ns/net')}));"
            if args.timeout_probe: code = "setInterval(() => {}, 1000)"
            command += ["--", "/runtime/node", "-e", code]
        else:
            selected = args.select or ["dom430-bridge/adapter.test.ts"]
            if any(not re.fullmatch(r"(?:dom430-bridge|server/src/[a-zA-Z0-9_/-]+)/[a-zA-Z0-9_.-]+\.test\.ts", x) for x in selected):
                raise SystemExit("fixed test paths only")
            command += ["--", "/runtime/node", "node_modules/vitest/vitest.mjs", "run", "--config", "dom430-bridge/vitest.config.ts", "--reporter=json", *selected]
            if args.pattern:
                if len(args.pattern) > 500 or (not args.negative_control and not re.fullmatch(r"[a-zA-Z0-9 _|.-]+", args.pattern)): raise SystemExit("bounded test-name filter only")
                command += ["--testNamePattern", args.pattern]
        service = ["/usr/bin/systemd-run", "--user", "--unit=" + unit, "--wait", "--pipe", "--collect",
                   "--property=MemoryMax=4G", "--property=CPUQuota=200%", "--property=TasksMax=128",
                   "--property=RuntimeMaxSec=300", "--property=TimeoutStopSec=5", "--property=KillMode=control-group", *command]
        safe_host_env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp/dd-paperclip-bootstrap-home"}
        for name in ("XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"):
            if os.environ.get(name): safe_host_env[name] = os.environ[name]
        began = time.monotonic()
        timed_out = False
        try:
            result = subprocess.run(service, env=safe_host_env, capture_output=True, text=True, timeout=2 if args.timeout_probe else 320)
        except subprocess.TimeoutExpired:
            timed_out = True
            result = subprocess.CompletedProcess(service, 124, "", "")
        finally:
            properties = {}
            inspection_known = False
            stop_return = None
            try:
                stopped = subprocess.run(["/usr/bin/systemctl", "--user", "stop", unit + ".service"], env=safe_host_env, capture_output=True, timeout=15)
                stop_return = stopped.returncode
                state = subprocess.run(["/usr/bin/systemctl", "--user", "show", unit + ".service", "--property=LoadState", "--property=ActiveState", "--property=SubState", "--property=ControlGroup"], env=safe_host_env, capture_output=True, text=True, timeout=10)
                properties = dict(line.split("=", 1) for line in state.stdout.splitlines() if "=" in line)
                inspection_known = state.returncode == 0 and properties.get("LoadState") in {"loaded", "not-found"} and properties.get("ActiveState") in {"inactive", "failed", "active", "activating", "deactivating"}
            except subprocess.TimeoutExpired:
                pass
            cgroup = properties.get("ControlGroup", "")
            process_file = Path("/sys/fs/cgroup") / cgroup.lstrip("/") / "cgroup.procs" if cgroup else None
            remaining = process_file.read_text().split() if process_file and process_file.exists() else []
            cleanup = {"inspectionKnown": inspection_known, "unitInactive": inspection_known and properties.get("ActiveState") in {"inactive", "failed"}, "remainingOwnedProcesses": len(remaining) if inspection_known else None, "unitState": properties.get("ActiveState", "unknown"), "loadState": properties.get("LoadState", "unknown"), "stopExitCode": stop_return}
        output = result.stdout + "\n" + result.stderr

        observations = []
        for line in (output + "\n" + observation_file.read_text()).splitlines():
            try: row = json.loads(line)
            except (json.JSONDecodeError, ValueError): continue
            if isinstance(row, dict) and row.get("schema") == "dom430.paperclip.authority.v1": observations.append(row)
        parsed = None
        if not args.probe and not args.timeout_probe and not args.typecheck:
            offset = output.find('{"numTotalTestSuites"')
            if offset >= 0:
                try: parsed, _ = json.JSONDecoder().raw_decode(output[offset:])
                except (ValueError, json.JSONDecodeError): pass
        report = {"startedUTC": started, "finishedUTC": datetime.now(timezone.utc).isoformat(),
                  "seconds": round(time.monotonic() - began, 3), "exitCode": result.returncode, "timedOut": timed_out, "cleanup": cleanup,
                  "syntheticOnly": True, "productionAndCredentialsPaused": True,
                  "contained": {"unit": unit, "privateHome": True, "externalNetworkNamespace": True,
                                "personalFilesMounted": False, "memoryMaxBytes": 4294967296, "tasksMax": 128, "runtimeMaxSeconds": 300},
                  "negativeControl": args.negative_control, "executedAdapterSHA256": hashlib.sha256(overlay.read_bytes()).hexdigest() if overlay and mutation_path == 'dom430-bridge/adapter.ts' else before['dom430-bridge/adapter.ts'],
                  "nodeRuntimeSHA256": hashlib.sha256(NODE.read_bytes()).hexdigest(), "sourceSHA256": before, "sourcesUnchanged": before == pins(), "authorityObservations": observations,
                  "formatterRetained": False, "rawLogsRetained": False, "mode": "typecheck" if args.typecheck else "test"}
        if overlay:
            report["mutation"] = {"path": mutation_path, "originalSHA256": hashlib.sha256(original.encode()).hexdigest(), "overlaySHA256": hashlib.sha256(overlay.read_bytes()).hexdigest(), "replacements": 1, "expectedAssertion": expected_name}
        if args.probe:
            report["probe"] = next((json.loads(line) for line in result.stdout.splitlines() if line.startswith('{"privateHome"')), None)
        if parsed:
            report.update({"tests": parsed.get("numTotalTests"), "passed": parsed.get("numPassedTests"),
                           "failed": parsed.get("numFailedTests"), "pending": parsed.get("numPendingTests"), "success": parsed.get("success"),
                           "testsByName": [{"name": case.get("fullName"), "status": case.get("status"), "assertionFailure": any("AssertionError" in message or re.search(r"^\s*Error: promise resolved\b.*\binstead of rejecting\b", message, re.IGNORECASE | re.DOTALL) for message in case.get("failureMessages", [])), "timeoutFailure": any("timed out" in message.lower() for message in case.get("failureMessages", [])), "rejectionMatcherFailure": any(re.search(r"promise resolved.*instead of rejecting", message, re.IGNORECASE | re.DOTALL) for message in case.get("failureMessages", [])), "errorClassNames": sorted(set(re.findall(r"\b(?:AssertionError|TimeoutError|TypeError|ReferenceError|SyntaxError|AggregateError|Error):", "\n".join(case.get("failureMessages", []))))), "assertionOnlyFailure": bool(case.get("failureMessages")) and all(("AssertionError" in message or re.search(r"^\s*Error: promise resolved\b.*\binstead of rejecting\b", message, re.IGNORECASE | re.DOTALL)) and not re.search(r"\b(?:TimeoutError|TypeError|ReferenceError|SyntaxError|AggregateError)\b|Hook timed out|Unhandled Error|beforeAll|afterAll|beforeEach|afterEach", message) for message in case.get("failureMessages", []))}
                            for suite in parsed.get("testResults", []) for case in suite.get("assertionResults", [])]})
            report["runtimeErrorSuites"] = sum(bool(suite.get("message")) and not suite.get("assertionResults") for suite in parsed.get("testResults", []))
            report["setupErrorSuites"] = sum(suite.get("status") == "failed" and not any(case.get("status") in {"passed", "failed"} for case in suite.get("assertionResults", [])) for suite in parsed.get("testResults", []))
            report["suiteStatuses"] = [{"file": Path(suite.get("name", "")).name, "status": suite.get("status"), "assertions": len(suite.get("assertionResults", []))} for suite in parsed.get("testResults", [])]
            report["moduleDiagnostics"] = {"packageNames": sorted(set(re.findall(r"(?:Cannot find package|resolve entry for package) [\"\']?([@a-zA-Z0-9_./-]+)", output))), "moduleBasenames": sorted(set(Path(x).name for x in re.findall(r"Cannot find module [\"\']([^\"\']+)", output))), "errorClasses": sorted(set(re.findall(r"\b(ERR_[A-Z_]+)\b", output)))}
            report["parsedKeys"] = sorted(parsed.keys())
            report["assertionFailureCategories"] = [{"keys": sorted(case.keys()), "kinds": sorted(set(re.findall(r"\b(?:EROFS|EACCES|ENOENT|ETIMEDOUT|EADDRNOTAVAIL|ECONNREFUSED)\b|Hook timed out|dom430_lab_failure:[0-9]+:[a-z_]+|Failed to start embedded|Test timed out|process exited", str(case.get("failureMessages", [])))))} for suite in parsed.get("testResults", []) for case in suite.get("assertionResults", []) if case.get("failureMessages")]
            report["failureKinds"] = sorted(set(re.findall(r"\b(?:EROFS|EACCES|ENOENT|ETIMEDOUT|EADDRNOTAVAIL|ECONNREFUSED)\b|Hook timed out|Cannot find package|Failed to start embedded|spawn.*?ENOENT", output + json.dumps(parsed))))
            report["failureMessagesSHA256"] = [hashlib.sha256(str(suite.get("message", "")).encode()).hexdigest() for suite in parsed.get("testResults", []) if suite.get("message")]
            report["safeFailureCodes"] = sorted(set(re.findall(r"dom430_lab_failure:[0-9]+:[a-z_]+", output + json.dumps(parsed))))
        elif args.typecheck:
            diagnostics = [{"file": Path(match.group(1)).name, "line": int(match.group(2)), "column": int(match.group(3)), "code": match.group(4)} for match in re.finditer(r"^([^\n]+?)\((\d+),(\d+)\): error (TS\d+):", output, re.MULTILINE)]
            global_codes = sorted(set(re.findall(r"\berror (TS\d+):", output)))
            files = sorted(set(line.strip() for line in result.stdout.splitlines() if line.startswith("/") and re.search(r"\.(?:ts|tsx|mts|cts)$", line)))
            file_hashes = {name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in files if Path(name).is_file()}
            report["typecheck"] = {"config": TYPECHECK_CONFIG, "entries": TYPECHECK_ENTRIES, "diagnostics": diagnostics, "diagnosticCodes": global_codes, "typedFileCount": len(files), "listedFilesSHA256": file_hashes, "entryFilesObserved": all(str((REPO / entry).resolve()) in files for entry in TYPECHECK_ENTRIES), "compilerSHA256": hashlib.sha256((REPO / "node_modules/typescript/bin/tsc").read_bytes()).hexdigest(), "noEmit": True, "wholeProductBuild": False}
        else:
            report["bootstrapDiagnostics"] = {"moduleNames": sorted(set(re.findall(r"Cannot find package '([@a-zA-Z0-9_./-]+)'", output))),
                "missingModuleBasenames": sorted(set(Path(x).name for x in re.findall(r"Cannot find module '([^']+)'", output))),
                "permissionError": "Permission denied" in output, "missingFile": "ENOENT" in output,
                "configFailed": "failed to load config" in output, "unhandledError": "Unhandled Error" in output}
        # Never save formatter messages, stacks, database clients, URLs or token values.
        args.report.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({k: v for k, v in report.items() if k not in {"sourceSHA256", "testsByName", "authorityObservations", "typecheck"}}))
        if args.typecheck: print(json.dumps({"typecheck": {k: v for k, v in report["typecheck"].items() if k != "listedFilesSHA256"}}))
        accepted = result.returncode == 0 and report["sourcesUnchanged"] and cleanup["unitInactive"] and cleanup["remainingOwnedProcesses"] == 0
        if args.timeout_probe: accepted = timed_out and cleanup["unitInactive"] and cleanup["remainingOwnedProcesses"] == 0
        elif args.typecheck: accepted = accepted and not report["typecheck"]["diagnosticCodes"] and report["typecheck"]["entryFilesObserved"] and report["typecheck"]["typedFileCount"] > 0
        elif not args.probe: accepted = accepted and bool(parsed) and report.get("success") is True and report.get("runtimeErrorSuites") == 0 and report.get("tests", 0) > 0 and report.get("passed", 0) > 0 and report.get("failed") == 0 and (report.get("pending") == 0 or bool(args.pattern))
        report["qualificationPassed"] = bool(accepted)
        if args.negative_control:
            cases = report.get("testsByName", [])
            failed_cases = [case for case in cases if case["status"] == "failed"]
            pending_cases = [case for case in cases if case["status"] in {"pending", "skipped"}]
            totals_match = report.get("tests") == len(cases) and report.get("failed") == len(failed_cases) and report.get("pending") == len(pending_cases)
            report["guardRemovalRejected"] = result.returncode != 0 and bool(parsed) and totals_match and len(failed_cases) == 1 and report.get("passed") == 0 and len(pending_cases) == len(cases) - 1 and failed_cases[0]["name"].endswith(expected_name) and failed_cases[0]["assertionOnlyFailure"] and not failed_cases[0]["timeoutFailure"] and report.get("runtimeErrorSuites") == 0 and report.get("setupErrorSuites") == 0 and not timed_out and report["sourcesUnchanged"] and cleanup["unitInactive"] and cleanup["remainingOwnedProcesses"] == 0
            report["guardCaseCounts"] = {"collected": len(cases), "expectedFailed": 1, "failed": len(failed_cases), "pending": len(pending_cases), "totalsMatch": totals_match, "statusCounts": {status: sum(case["status"] == status for case in cases) for status in sorted(set(case["status"] for case in cases))}}
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    report["cleanup"]["outerTemporaryRemoved"] = not private.exists()
    report["qualificationPassed"] = report["qualificationPassed"] and not private.exists()
    if args.negative_control: report["guardRemovalRejected"] = report["guardRemovalRejected"] and not private.exists()
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    return 0 if report["qualificationPassed"] or report.get("guardRemovalRejected") else 1

if __name__ == "__main__":
    raise SystemExit(main())
