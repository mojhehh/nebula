#!/usr/bin/env python3
"""
Simple MPEG-TS Audio WebSocket Relay
Receives MPEG-TS audio from ffmpeg via HTTP POST on port 8081,
broadcasts it to WebSocket clients on port 4901 (no SSL).
Replaces kasm_audio_out-linux which closes all external connections.
"""

import socket
import struct
import hashlib
import base64
import threading
import sys
import time

STREAM_PORT = 8081
WS_PORT = 4901
BUFFER_SIZE = 65536

ws_clients = []
ws_clients_lock = threading.Lock()


def websocket_accept_key(key):
    """Calculate Sec-WebSocket-Accept from client key."""
    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    sha1 = hashlib.sha1((key + GUID).encode()).digest()
    return base64.b64encode(sha1).decode()


def make_ws_frame(data, opcode=0x02):
    """Create a WebSocket binary frame."""
    frame = bytearray()
    frame.append(0x80 | opcode)  # FIN + opcode
    length = len(data)
    if length < 126:
        frame.append(length)
    elif length < 65536:
        frame.append(126)
        frame.extend(struct.pack(">H", length))
    else:
        frame.append(127)
        frame.extend(struct.pack(">Q", length))
    frame.extend(data)
    return bytes(frame)


def broadcast(data):
    """Send data to all connected WebSocket clients."""
    frame = make_ws_frame(data)
    with ws_clients_lock:
        dead = []
        for client in ws_clients:
            try:
                client.sendall(frame)
            except Exception:
                dead.append(client)
        for d in dead:
            ws_clients.remove(d)
            try:
                d.close()
            except Exception:
                pass


def handle_ws_client(conn, addr):
    """Handle a new WebSocket client connection."""
    try:
        # Read HTTP upgrade request
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = conn.recv(4096)
            if not chunk:
                conn.close()
                return
            data += chunk

        # Parse Sec-WebSocket-Key
        key = None
        for line in data.decode("utf-8", errors="replace").split("\r\n"):
            if line.lower().startswith("sec-websocket-key:"):
                key = line.split(":", 1)[1].strip()
                break

        if not key:
            conn.close()
            return

        # Send upgrade response
        accept = websocket_accept_key(key)
        response = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n"
            "\r\n"
        )
        conn.sendall(response.encode())

        # Add to broadcast list
        with ws_clients_lock:
            ws_clients.append(conn)
        print(f"[WS] Client connected from {addr}, total: {len(ws_clients)}")

        # Keep connection alive - read and handle control frames
        while True:
            try:
                frame = conn.recv(4096)
                if not frame:
                    break
                # Parse WebSocket frame
                if len(frame) >= 2:
                    opcode = frame[0] & 0x0F
                    if opcode == 0x08:  # Close
                        # Send close back
                        try:
                            conn.sendall(make_ws_frame(b"", 0x08))
                        except Exception:
                            pass
                        break
                    elif opcode == 0x09:  # Ping
                        # Respond with pong
                        try:
                            conn.sendall(make_ws_frame(b"", 0x0A))
                        except Exception:
                            pass
            except Exception:
                break

        # Remove from list
        with ws_clients_lock:
            if conn in ws_clients:
                ws_clients.remove(conn)
        print(f"[WS] Client disconnected from {addr}, total: {len(ws_clients)}")
        conn.close()
    except Exception as e:
        print(f"[WS] Error handling client {addr}: {e}")
        try:
            conn.close()
        except Exception:
            pass


def ws_server():
    """WebSocket server - accepts client connections on WS_PORT."""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", WS_PORT))
    server.listen(10)
    print(f"[WS] WebSocket server listening on port {WS_PORT}")

    while True:
        try:
            conn, addr = server.accept()
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            t = threading.Thread(target=handle_ws_client, args=(conn, addr), daemon=True)
            t.start()
        except Exception as e:
            print(f"[WS] Accept error: {e}")


def stream_server():
    """HTTP server - receives MPEG-TS stream from ffmpeg on STREAM_PORT."""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", STREAM_PORT))
    server.listen(5)
    print(f"[STREAM] HTTP stream server listening on port {STREAM_PORT}")

    while True:
        try:
            conn, addr = server.accept()
            print(f"[STREAM] ffmpeg connected from {addr}")
            t = threading.Thread(target=handle_stream, args=(conn, addr), daemon=True)
            t.start()
        except Exception as e:
            print(f"[STREAM] Accept error: {e}")


def handle_stream(conn, addr):
    """Handle incoming MPEG-TS stream from ffmpeg."""
    try:
        # Read HTTP headers
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = conn.recv(4096)
            if not chunk:
                conn.close()
                return
            data += chunk

        # Send HTTP 200 response
        response = (
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: application/octet-stream\r\n"
            "Connection: keep-alive\r\n"
            "\r\n"
        )
        conn.sendall(response.encode())
        print(f"[STREAM] Accepted stream from ffmpeg")

        # Get any data after the headers
        header_end = data.index(b"\r\n\r\n") + 4
        leftover = data[header_end:]
        if leftover:
            broadcast(leftover)

        # Read and broadcast audio data
        while True:
            chunk = conn.recv(BUFFER_SIZE)
            if not chunk:
                print(f"[STREAM] ffmpeg disconnected")
                break
            broadcast(chunk)
    except Exception as e:
        print(f"[STREAM] Stream error from {addr}: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    print("[RELAY] Audio relay starting...")
    print(f"[RELAY] Stream input: port {STREAM_PORT}")
    print(f"[RELAY] WebSocket output: port {WS_PORT}")

    # Start WebSocket server in a thread
    ws_thread = threading.Thread(target=ws_server, daemon=True)
    ws_thread.start()

    # Run stream server in main thread
    stream_server()
