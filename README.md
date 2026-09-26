# Image Editor Web App

A web-based image editor that allows users to remove backgrounds from images and make basic edits. Built with Flask and Python.

## Features

- Background removal from images
- Dimension and Aspect Ratio adjustments
- Multiple images upload and download functionality
- Simple and intuitive user interface
- Real-time image processing
- Download the current image as PNG or the whole batch as a ZIP
- Keep each image's crop, dimensions, rotation, flips, and background when switching images

## Try it out!

You can try the application directly at:
[https://shannenlolol.pythonanywhere.com/]

## How it works:

### Main Interface
![Screenshot of the main interface showing the upload area and editing tools](static/assets/screenshots/main_interface.png)

### Background Removal
![Screenshot demonstrating the background removal feature](static/assets/screenshots/background_removal.png)

### Change Background
![Screenshot showing the background changed](static/assets/screenshots/change_background.png)

### Change Resolution and Aspect Ratio
![Screenshot showing the resolution changed](static/assets/screenshots/resize_resolution_aspect_ratio.png)

### Upload multiple images and browse through/remove them
![Screenshot showing the multiple images](static/assets/screenshots/upload_multiple.jpeg)


## Local Installation (Optional)

If you want to run this application locally:

1. Clone the repository:
```bash
git clone https://github.com/yourusername/ImageEditorWebApp.git
cd ImageEditorWebApp
```

2. Create a virtual environment (recommended):
```bash
python -m venv venv
source venv/bin/activate  # On Windows, use: venv\Scripts\activate
```

3. Install the required packages:
```bash
pip install -r requirements.txt
```

4. Start the Flask application:
```bash
python app.py
```

5. Open your web browser and navigate to:
```
http://localhost:5000
```

## Frontend regression tests

With Node.js 18 or newer installed, run:

```bash
node --test tests/*.test.cjs
```

These tests load the external scripts in the order used by the page, with controlled
network responses, image decoding, and canvas rendering. They cover image switching,
controls, background removal, per-image state, and export races. ZIP tests use the
vendored JSZip library and reopen the generated archives to inspect their entries.
They do not require Flask or a background-removal model. Browser layout and actual
pixel rendering still need a browser smoke test.

## Frontend structure

- `templates/index.html`: page structure and script loading.
- `static/style.css`: layout, responsive styles, and control appearance.
- `static/editor.js`: image records, processing requests, Cropper lifecycle, uploads,
  and PNG/ZIP export. It exposes the `window.ImageEditor` API; internal state stays
  inside its closure.
- `static/controls.js`: panels, preset and download menus, rotation, and background
  controls. It uses that API and registers UI callbacks with `attachControls()`.
- `static/vendor/`: pinned JSZip 3.10.1 and its license. No build step is required.

Load Cropper and JSZip before `editor.js`, then `controls.js`, after the page markup.
The tests read these script tags so they exercise the same files and order.

## Downloads

The Download menu offers **Download current image** and **Download all as ZIP**.
Downloads are generated locally in the browser; only background removal sends image
data to the server. The former `/upload-edited` round trip is no longer used.

Edited/visited images are exported as PNG with their current dimensions and settings.
Images that have never been opened in the editor retain their original file bytes
and filename in the ZIP. Duplicate filenames receive numeric suffixes.

Switching away saves the image's settings, crop data, and rendered canvas. ZIP export
takes a snapshot of those canvases, so later edits, uploads, and removals do not
change an in-progress download. Interrupted processing or invalid dimensions must
be resolved before that image can be included; a failed export does not download a
partial archive. Saved canvases and ZIP bytes live in browser memory, so very large
batches are constrained by available memory.

## Technologies Used

- Python
- Flask
- rembg (for background removal)
- PIL (Python Imaging Library)
- HTML/CSS/JavaScript


## License

This project is licensed under the MIT License - see the LICENSE file for details.
