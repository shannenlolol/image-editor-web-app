from flask import Flask, request, send_file, render_template, jsonify
from rembg import remove
from PIL import Image, UnidentifiedImageError
from io import BytesIO
import warnings
from werkzeug.exceptions import RequestEntityTooLarge

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024
app.config['MAX_IMAGE_PIXELS'] = 25_000_000
SUPPORTED_IMAGE_FORMATS = {'PNG', 'JPEG', 'WEBP', 'GIF', 'BMP', 'TIFF'}


@app.errorhandler(RequestEntityTooLarge)
def request_too_large(error):
    return jsonify({'message': 'Upload is too large. Maximum request size is 20 MiB.'}), 413

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/remove-bg', methods=['POST'])
def remove_bg():
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
                input_image = image.convert('RGBA')
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        return jsonify({'message': 'Image is too large. Maximum decoded size is 25 megapixels.'}), 413
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, EOFError):
        return jsonify({'message': 'Invalid or damaged image. Upload a supported image file.'}), 400

    with input_image:
        output_image = remove(input_image)
        img_byte_arr = BytesIO()
        output_image.save(img_byte_arr, format='PNG')
        img_byte_arr.seek(0)
        return send_file(img_byte_arr, mimetype='image/png')

if __name__ == '__main__':
    app.run(debug=True)
