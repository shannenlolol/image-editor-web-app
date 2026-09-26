# Image Editor Web App

A web-based image editor that allows users to remove backgrounds from images and make basic edits. Built with Flask and Python.

## Features

- Background removal from images
- Dimension and Aspect Ratio adjustments
- Multiple images upload and download functionality
- Simple and intuitive user interface
- Real-time image processing

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

These tests load the external scripts in page order with controlled network responses and image
decoding to check image switching, background-removal toggles, removal, and export
races. They do not require Flask or a background-removal model.

## Frontend structure

- `templates/index.html`: page structure and script loading.
- `static/style.css`: layout, responsive styles, and control appearance.
- `static/editor.js`: image processing, Cropper lifecycle, uploads, and exports.
  It exposes the `window.ImageEditor` API; internal state stays inside its closure.
- `static/controls.js`: panels, dropdowns, rotation, and background controls.
  It uses that API and registers UI callbacks with `attachControls()`.

Load Cropper before `editor.js`, then `controls.js`, after the page markup.
The tests read these script tags so they exercise the same files and order.
No build step is required.

## Technologies Used

- Python
- Flask
- rembg (for background removal)
- PIL (Python Imaging Library)
- HTML/CSS/JavaScript


## License

This project is licensed under the MIT License - see the LICENSE file for details.
