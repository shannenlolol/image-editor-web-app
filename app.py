from flask import Flask, request, send_file, render_template, jsonify
from rembg import remove, new_session
from PIL import Image, ImageOps, UnidentifiedImageError
from io import BytesIO
from collections import deque
import os
import threading
import time
import warnings
from werkzeug.exceptions import RequestEntityTooLarge

bg_session = new_session("u2netp")

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024
app.config['MAX_IMAGE_PIXELS'] = 25_000_000
SUPPORTED_IMAGE_FORMATS = {'PNG', 'JPEG', 'WEBP', 'GIF', 'BMP', 'TIFF'}
# Only trust Cloudflare's client IP header behind the tunnel; anywhere else a
# client could send it themselves to dodge the rate limit.
app.config['TRUST_CF_CONNECTING_IP'] = os.environ.get('TRUST_CF_CONNECTING_IP') == '1'
app.config['REMOVAL_RATE_LIMIT'] = 10
app.config['REMOVAL_RATE_WINDOW_SECONDS'] = 60

# Each removal holds about 250 MB, so cap how many run at once regardless of
# how many clients get past the per-IP limits.
MAX_CONCURRENT_REMOVALS = 2
removal_slots = threading.BoundedSemaphore(MAX_CONCURRENT_REMOVALS)

# Sliding-window rate limit per client IP: a deque of recent request times.
# In-memory is enough because the app runs as a single process.
recent_removals = {}
recent_removals_lock = threading.Lock()

CONTENT_SECURITY_POLICY = '; '.join([
    "default-src 'self'",
    # Cropper's stylesheet draws its checkerboard from a data: URL, and the
    # editor previews images through blob: URLs.
    "img-src 'self' data: blob:",
    # Cropper reads blob: images with XMLHttpRequest to check EXIF orientation.
    "connect-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])


def client_ip():
    if app.config['TRUST_CF_CONNECTING_IP']:
        return request.headers.get('CF-Connecting-IP') or request.remote_addr
    return request.remote_addr


def rate_limited(ip):
    now = time.monotonic()
    window = app.config['REMOVAL_RATE_WINDOW_SECONDS']
    with recent_removals_lock:
        # Drop idle clients so the table does not grow with every IP ever seen.
        for key in [key for key, times in recent_removals.items() if now - times[-1] >= window]:
            del recent_removals[key]
        times = recent_removals.setdefault(ip, deque())
        while times and now - times[0] >= window:
            times.popleft()
        if len(times) >= app.config['REMOVAL_RATE_LIMIT']:
            return True
        times.append(now)
        return False


@app.after_request
def set_security_headers(response):
    response.headers['Content-Security-Policy'] = CONTENT_SECURITY_POLICY
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    return response


@app.errorhandler(RequestEntityTooLarge)
def request_too_large(error):
    return jsonify({'message': 'Upload is too large. Maximum request size is 20 MiB.'}), 413

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/healthz')
def healthz():
    return 'ok', 200, {'Content-Type': 'text/plain'}

@app.route('/remove-bg', methods=['POST'])
def remove_bg():
    return run_removal(only_mask=False)


# Returns just the greyscale mask. The page uploads a downscaled copy of large
# photos and applies the mask to the original in the browser, so the cut-out
# keeps full resolution. /remove-bg stays for images the browser cannot decode.
@app.route('/remove-bg/mask', methods=['POST'])
def remove_bg_mask():
    return run_removal(only_mask=True)


def run_removal(only_mask):
    if rate_limited(client_ip()):
        return jsonify({'message': 'Too many requests. Please wait a minute and try again.'}), 429
    if 'file' not in request.files:
        return jsonify({'message': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'message': 'No selected file'}), 400
    data = file.read()
    if not data:
        return jsonify({'message': 'The uploaded file is empty.'}), 400

    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                if image.format not in SUPPORTED_IMAGE_FORMATS:
                    return jsonify({'message': 'Unsupported image format. Use PNG, JPEG, WebP, GIF, BMP or TIFF.'}), 415
                if image.width * image.height > app.config['MAX_IMAGE_PIXELS']:
                    return jsonify({'message': 'Image is too large. Maximum decoded size is 25 megapixels.'}), 413
                image.verify()
            # verify() invalidates the decoder. Reopen and fully decode before inference.
            with Image.open(BytesIO(data)) as image:
                image.load()
                # Browsers draw photos upright using EXIF orientation, so the mask
                # must be computed on the upright image to line up in the page.
                input_image = ImageOps.exif_transpose(image).convert('RGBA')
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        return jsonify({'message': 'Image is too large. Maximum decoded size is 25 megapixels.'}), 413
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, EOFError):
        return jsonify({'message': 'Invalid or damaged image. Upload a supported image file.'}), 400

    with input_image:
        if not removal_slots.acquire(blocking=False):
            return jsonify({'message': 'Busy, please try again in a few seconds.'}), 503
        try:
            output_image = remove(input_image, session=bg_session, only_mask=only_mask)
        finally:
            removal_slots.release()
        if only_mask:
            output_image = output_image.convert('L')
        img_byte_arr = BytesIO()
        output_image.save(img_byte_arr, format='PNG')
        img_byte_arr.seek(0)
        return send_file(img_byte_arr, mimetype='image/png')

if __name__ == '__main__':
    app.run(debug=True)
