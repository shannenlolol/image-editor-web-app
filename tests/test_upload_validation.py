"""Exercise real image decoders and HTTP uploads without loading an ML model."""
import importlib.util
from io import BytesIO
from pathlib import Path
import struct
import sys
import types
import unittest
from unittest.mock import Mock, patch
import zlib

from PIL import Image
from werkzeug.test import EnvironBuilder


spec = importlib.util.spec_from_file_location(
    'upload_test_app', Path(__file__).resolve().parents[1] / 'app.py'
)
backend = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'rembg': types.SimpleNamespace(remove=Mock())}):
    spec.loader.exec_module(backend)


def image_bytes(image_format='PNG', size=(8, 6)):
    stream = BytesIO()
    Image.new('RGB', size, 'red').save(stream, format=image_format)
    return stream.getvalue()


def oversized_png(width, height):
    # Rewrite only the header and its CRC: validation must reject before decoding.
    data = image_bytes()
    header = struct.pack('>II', width, height) + data[24:29]
    crc = struct.pack('>I', zlib.crc32(b'IHDR' + header))
    return data[:16] + header + crc + data[33:]


class UploadValidationTests(unittest.TestCase):
    def setUp(self):
        self.client = backend.app.test_client()
        self.inference = patch.object(backend, 'remove', side_effect=lambda image: image)
        self.remove = self.inference.start()
        self.addCleanup(self.inference.stop)

    def upload(self, data, filename='image.png', content_type='image/png'):
        builder = EnvironBuilder(path='/remove-bg', method='POST', data={
            'file': (BytesIO(data), filename, content_type),
        })
        environ = builder.get_environ()
        try:
            response = self.client.open(environ)
        finally:
            environ['wsgi.input'].close()
            builder.close()
        self.addCleanup(response.close)
        return response

    def assert_rejected(self, response, status, message):
        self.assertEqual(response.status_code, status)
        self.assertEqual(response.mimetype, 'application/json')
        self.assertEqual(set(response.json), {'message'})
        self.assertIn(message, response.json['message'])
        self.remove.assert_not_called()

    def test_missing_file(self):
        self.assert_rejected(self.client.post('/remove-bg'), 400, 'No file')

    def test_missing_filename(self):
        self.assert_rejected(self.upload(image_bytes(), ''), 400, 'No selected file')

    def test_empty_file(self):
        self.assert_rejected(self.upload(b''), 400, 'empty')

    def test_corrupt_and_disguised_files(self):
        for data in (b'not an image', b'<svg></svg>', image_bytes()[:45]):
            with self.subTest(data=data):
                self.assert_rejected(self.upload(data), 400, 'Invalid or damaged')

    def test_truncated_image_that_opens_but_cannot_decode(self):
        data = image_bytes('BMP')[:-20]
        with Image.open(BytesIO(data)) as image:
            self.assertEqual(image.size, (8, 6))
        self.assert_rejected(self.upload(data), 400, 'Invalid or damaged')

    def test_unsupported_decodable_format(self):
        self.assert_rejected(self.upload(image_bytes('PPM')), 415, 'Unsupported')

    def test_request_limit(self):
        self.assertEqual(backend.app.config['MAX_CONTENT_LENGTH'], 20 * 1024 * 1024)
        response = self.upload(b'x' * backend.app.config['MAX_CONTENT_LENGTH'])
        self.assert_rejected(response, 413, '20 MiB')

    def test_pixel_limit_before_decode(self):
        self.assertEqual(backend.app.config['MAX_IMAGE_PIXELS'], 25_000_000)
        self.assert_rejected(self.upload(oversized_png(5001, 5000)), 413, '25 megapixels')

    def test_pillow_decompression_bomb_warning_and_error(self):
        for side in (10000, 20000):
            with self.subTest(side=side):
                self.assert_rejected(self.upload(oversized_png(side, side)), 413, '25 megapixels')

    def test_pixel_limit_is_inclusive(self):
        with patch.dict(backend.app.config, MAX_IMAGE_PIXELS=48):
            self.assertEqual(self.upload(image_bytes()).status_code, 200)

    def test_supported_formats_are_decoded_regardless_of_filename_and_mime(self):
        for image_format in sorted(backend.SUPPORTED_IMAGE_FORMATS):
            with self.subTest(image_format=image_format):
                self.remove.reset_mock()
                response = self.upload(image_bytes(image_format), 'wrong.txt', 'text/plain')
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.mimetype, 'image/png')
                self.remove.assert_called_once()
                with Image.open(BytesIO(response.data)) as output:
                    self.assertEqual(output.size, (8, 6))
                    self.assertEqual(output.format, 'PNG')
                    self.assertGreater(output.convert('RGB').getpixel((0, 0))[0], 240)

    def test_valid_upload_after_rejection(self):
        self.assert_rejected(self.upload(b'bad'), 400, 'Invalid')
        self.assertEqual(self.upload(image_bytes()).status_code, 200)
        self.remove.assert_called_once()


if __name__ == '__main__':
    unittest.main()
