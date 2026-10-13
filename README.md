# Image Editor Web App

A simple web-based image editor for removing backgrounds and making quick edits, all in your browser. Built with Flask and Python.

## Try it out!

You can use the app directly here:
[https://shannenlolol.pythonanywhere.com/](https://shannenlolol.pythonanywhere.com/)

## Features

- **Remove backgrounds** from your images with one click
- **Replace the background** with transparent, white, black, or any colour you pick
- **Crop** freely or use aspect ratio presets
- **Resize** by setting exact width and height
- **Rotate and flip** images, including fine-tune angle adjustment
- **Upload multiple images** and switch between them easily
- **Remembers your edits** for each image when you switch between them
- **Download** the current image as a PNG, or all images together as a ZIP
- **Light and dark mode** that works on desktop and mobile

## How it works

### Main Interface
![Main interface showing the upload area and editing tools](static/assets/screenshots/main_interface.webp)

### Remove Background
![Background removal feature before](static/assets/screenshots/background_removal_before.webp)
![Background removal feature after](static/assets/screenshots/background_removal_after.webp)

### Change Background
![Changing the background colour](static/assets/screenshots/change_background.webp)

### Resize and Aspect Ratio
![Changing the dimensions and aspect ratio](static/assets/screenshots/resize_resolution_aspect_ratio.webp)

### Rotate and Flip
![Rotating and flipping an image](static/assets/screenshots/rotate_flip.webp)

### Multiple Images
![Uploading and browsing multiple images](static/assets/screenshots/upload_multiple.webp)

### Download
![Download menu with current image and ZIP options](static/assets/screenshots/download_menu.webp)

### Dark Mode
![The app in dark mode](static/assets/screenshots/dark_mode.webp)

## Run it locally (optional)

1. Clone the repository:
```bash
git clone https://github.com/shannenlolol/image-editor-web-app.git
cd image-editor-web-app
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

4. Start the app:
```bash
python app.py
```

5. Open your browser and go to:
```
http://localhost:5000
```

## Self-host with Docker

Every push to `main` publishes a ready-built image (Intel and ARM) to `ghcr.io/shannenlolol/image-editor-web-app`, so the server only downloads it:

```bash
git clone https://github.com/shannenlolol/image-editor-web-app.git
cd image-editor-web-app
docker compose pull
docker compose up -d
curl http://127.0.0.1:8081/healthz   # prints "ok"
```

The app only listens on `127.0.0.1:8081`; publish it through a reverse proxy or a Cloudflare Tunnel. `docker-compose.yml` sets `TRUST_CF_CONNECTING_IP=1`, which is only safe behind Cloudflare: remove it otherwise.

The container is labelled for [Watchtower](https://containrrr.dev/watchtower/), which installs new images automatically. If Watchtower is not already running on the server, add this service to `docker-compose.yml`:

```yaml
  watchtower:
    image: containrrr/watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      WATCHTOWER_LABEL_ENABLE: "true"   # only update labelled containers
      WATCHTOWER_CLEANUP: "true"        # delete replaced images
      WATCHTOWER_POLL_INTERVAL: "300"   # check every 5 minutes
```

## Built with

Python, Flask, rembg, Pillow, and HTML/CSS/JavaScript.

## Photo credits

The example images in the screenshots are from [Unsplash](https://unsplash.com):

- Photo by Insung Yoon on Unsplash
- Photo by Andy Hermawan on Unsplash
- Photo by JK Sloan on Unsplash