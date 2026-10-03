"""Windows clipboard images with straight (not premultiplied) RGBA for Photoshop."""
import io
import ipaddress
import os
import struct
import threading
from urllib.parse import urlsplit

_clipboard_lock = threading.Lock()


def is_local_clipboard_request(request):
    """Only a same-origin page connected directly to loopback may write here."""
    try:
        if not ipaddress.ip_address(request.remote).is_loopback:
            return False
        host = urlsplit("//" + request.host).hostname
        if host != "localhost" and not ipaddress.ip_address(host).is_loopback:
            return False
        origin = urlsplit(request.headers.get("Origin", ""))
        return origin.scheme in ("http", "https") and origin.netloc == request.host
    except (ValueError, TypeError):
        return False


def make_dibv5(image):
    """124-byte BITMAPV5HEADER followed by top-down, straight-alpha BGRA."""
    rgba = image.convert("RGBA")
    pixels = rgba.tobytes("raw", "BGRA")
    header = bytearray(124)
    struct.pack_into("<IiiHHIIiiII", header, 0,
                     124, rgba.width, -rgba.height, 1, 32, 3, len(pixels), 0, 0, 0, 0)
    struct.pack_into("<IIIII", header, 40,
                     0x00FF0000, 0x0000FF00, 0x000000FF, 0xFF000000, 0x73524742)
    struct.pack_into("<I", header, 108, 4)  # LCS_GM_IMAGES
    return bytes(header) + pixels


def copy_windows_image(image):
    if os.name != "nt":
        raise RuntimeError("Windows clipboard is unavailable")
    import ctypes
    from ctypes import wintypes

    dib = make_dibv5(image)
    stream = io.BytesIO()
    image.convert("RGBA").save(stream, "PNG")
    png = stream.getvalue()
    user = ctypes.WinDLL("user32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    signatures = [
        (user.CreateWindowExW, [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
                               ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                               wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, ctypes.c_void_p], wintypes.HWND),
        (user.DestroyWindow, [wintypes.HWND], wintypes.BOOL),
        (user.OpenClipboard, [wintypes.HWND], wintypes.BOOL),
        (user.EmptyClipboard, [], wintypes.BOOL),
        (user.CloseClipboard, [], wintypes.BOOL),
        (user.RegisterClipboardFormatW, [wintypes.LPCWSTR], wintypes.UINT),
        (user.SetClipboardData, [wintypes.UINT, wintypes.HANDLE], wintypes.HANDLE),
        (kernel.GlobalAlloc, [wintypes.UINT, ctypes.c_size_t], wintypes.HGLOBAL),
        (kernel.GlobalLock, [wintypes.HGLOBAL], ctypes.c_void_p),
        (kernel.GlobalUnlock, [wintypes.HGLOBAL], wintypes.BOOL),
        (kernel.GlobalFree, [wintypes.HGLOBAL], wintypes.HGLOBAL),
    ]
    for function, args, result in signatures:
        function.argtypes, function.restype = args, result

    with _clipboard_lock:
        # A real owner is required: OpenClipboard(NULL) + EmptyClipboard may
        # leave SetClipboardData without an owner. This window is message-only.
        owner = user.CreateWindowExW(0, "STATIC", "XZG clipboard", 0,
                                     0, 0, 0, 0, wintypes.HWND(-3), None, None, None)
        if not owner:
            raise ctypes.WinError(ctypes.get_last_error())
        pending = []
        opened = False
        try:
            png_format = user.RegisterClipboardFormatW("PNG")
            if not png_format:
                raise ctypes.WinError(ctypes.get_last_error())
            # Prepare both blocks before changing the current clipboard.
            for format_id, data in ((17, dib), (png_format, png)):
                handle = kernel.GlobalAlloc(0x0002, len(data))  # GMEM_MOVEABLE
                if not handle:
                    raise ctypes.WinError(ctypes.get_last_error())
                pending.append([format_id, handle])
                pointer = kernel.GlobalLock(handle)
                if not pointer:
                    raise ctypes.WinError(ctypes.get_last_error())
                try:
                    ctypes.memmove(pointer, data, len(data))
                finally:
                    kernel.GlobalUnlock(handle)
            if not user.OpenClipboard(owner):
                raise RuntimeError("剪贴板正在被其他程序占用，请稍后重试")
            opened = True
            if not user.EmptyClipboard():
                raise ctypes.WinError(ctypes.get_last_error())
            for entry in pending:
                if not user.SetClipboardData(*entry):
                    raise ctypes.WinError(ctypes.get_last_error())
                entry[1] = None  # Windows owns the memory after successful transfer.
        finally:
            if opened:
                user.CloseClipboard()
            for _, handle in pending:
                if handle:
                    kernel.GlobalFree(handle)
            user.DestroyWindow(owner)
