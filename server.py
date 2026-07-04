from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os
import subprocess
import webbrowser

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)

class LocalHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, format, *args):
        pass

URL = "http://127.0.0.1:8788"
def open_browser():
    if os.environ.get("FOCUS_REMINDER_NO_BROWSER") == "1":
        return
    edge = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
    if edge.exists():
        subprocess.Popen([str(edge), URL])
    else:
        webbrowser.open(URL)

try:
    server = ThreadingHTTPServer(("127.0.0.1", 8788), LocalHandler)
except OSError:
    # The service is already running; just bring the app back to the browser.
    open_browser()
    raise SystemExit(0)

print(f"Focus Reminder is running at {URL}")
open_browser()

try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
