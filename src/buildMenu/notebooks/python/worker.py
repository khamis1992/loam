import json
import sys
import time
from queue import Empty

from jupyter_client import KernelManager


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    km = KernelManager(kernel_name="python3")
    km.start_kernel(cwd="/output")
    kc = km.client()
    kc.start_channels()
    current_cell = ""
    try:
        kc.wait_for_ready(timeout=20)
        for line in sys.stdin:
            command = json.loads(line)
            if command.get("type") == "shutdown":
                break
            if command.get("type") != "execute" or not isinstance(command.get("code"), str):
                refused = {"type": "error", "error": "invalid_request"}
                if isinstance(command.get("cellId"), str):
                    refused["cellId"] = command["cellId"]
                emit(refused)
                continue
            cell_id = str(command.get("cellId", ""))
            current_cell = cell_id
            if len(command["code"].encode()) > 200000:
                emit({"type": "error", "cellId": cell_id, "error": "cell_too_large"})
                continue
            message_id = kc.execute(command["code"], stop_on_error=True)
            deadline = time.monotonic() + 30
            size = 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("cell_timeout")
                try:
                    message = kc.get_iopub_msg(timeout=min(remaining, 1))
                except Empty:
                    continue
                if message.get("parent_header", {}).get("msg_id") != message_id:
                    continue
                size += len(json.dumps(message).encode())
                if size > 1000000:
                    raise RuntimeError("output_limit")
                emit({
                    "type": "output",
                    "cellId": cell_id,
                    "messageType": message["header"]["msg_type"],
                    "content": message["content"],
                })
                if message["header"]["msg_type"] == "status" and message["content"].get("execution_state") == "idle":
                    emit({"type": "complete", "cellId": cell_id})
                    break
    except Exception as error:
        failed = {"type": "error", "error": str(error)[:500]}
        if current_cell:
            failed["cellId"] = current_cell
        emit(failed)
        raise
    finally:
        kc.stop_channels()
        km.shutdown_kernel(now=True)


if __name__ == "__main__":
    main()
