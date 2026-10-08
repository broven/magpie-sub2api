# A stand-in for Anthropic's API: every /v1/messages request is answered
# "hi" with 100k input and 50k output tokens, streamed or not, so a single
# request through sub2api costs about a dollar and every window moves.
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n=int(self.headers.get('content-length') or 0); body=json.loads(self.rfile.read(n) or b'{}')
        print("POST", self.path, body.get("model"), "stream=",body.get("stream"), flush=True)
        model=body.get("model","claude-sonnet-4-5")
        if body.get("stream"):
            self.send_response(200); self.send_header('content-type','text/event-stream'); self.end_headers()
            ev=[("message_start",{"type":"message_start","message":{"id":"msg_fake","type":"message","role":"assistant","model":model,"content":[],"stop_reason":None,"usage":{"input_tokens":100000,"output_tokens":1}}}),
                ("content_block_start",{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                ("content_block_delta",{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}),
                ("content_block_stop",{"type":"content_block_stop","index":0}),
                ("message_delta",{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50000}}),
                ("message_stop",{"type":"message_stop"})]
            for e,d in ev: self.wfile.write(f"event: {e}\ndata: {json.dumps(d)}\n\n".encode())
            return
        out=json.dumps({"id":"msg_fake","type":"message","role":"assistant","model":model,"content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":100000,"output_tokens":50000}}).encode()
        self.send_response(200); self.send_header('content-type','application/json'); self.send_header('content-length',str(len(out))); self.end_headers(); self.wfile.write(out)
    def do_GET(self):
        out=b'{"data":[]}'; self.send_response(200); self.send_header('content-type','application/json'); self.end_headers(); self.wfile.write(out)
ThreadingHTTPServer(("0.0.0.0",8000),H).serve_forever()
