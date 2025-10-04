# PhotoFrame
#### A custom photo frame card for Home Assistant

![Automatic slideshow](docs/images/preview2.gif)
![Manual navigation](docs/images/manual-navigation.gif)

# Features

- Images are accessed using [Media source](https://www.home-assistant.io/integrations/media_source/) integration
  - *"Files served from `media` are protected by Home Assistant authentication unlike those served from `www`."*
- Navigate back and forth within recent images
- Works with Home Assistant Section, Masonry and Single-Panel layouts
- Other:
  - Configurable slideshow interval
  - Configurable delay when manually navigating
  - NEW: Crossfade transition
  - File extension filter (jpg, jpeg, png, gif, webp, heic)
  - Random or filename-based slideshow order
  - Upload pictures from your phone via Media Browser panel

# Installation

## Home Assistant Configuration
Create the `/media/photo-frame-images` folder (e.g. using Media Browser panel) and adjust your Home Assistant `configuration.yaml` as follows:

```yaml
# configuration.yaml
homeassistant:
  media_dirs:
    media: /media

media_source:

sensor:
- platform: folder
  folder: /media/photo-frame-images
```

## PhotoFrame Card

### HACS (recommended)
1. Add repository `https://github.com/tienducle/photo-frame` to HACS with type `Dashboard`
2. Install PhotoFrame from HACS

### Manual
1. Create a folder named `photo-frame` in the `www` folder of your Home Assistant installation.
2. Copy the `photo-frame.js` file from the [releases](https://github.com/tienducle/photo-frame/releases) page to the `photo-frame` folder.
3. Under Home Assistant Settings -> Dashboards, click on the three-dots and open Resources
4. Add a new resource with type `Module` and URL `/local/photo-frame/photo-frame.js`
5. Do not blindly copy&paste URLs from random strangers on the internet in here 🤷🏻‍♂️

# Usage

1. Upload some images to your `/media/photo-frame-images` folder
2. Add PhotoFrame card to your dashboard
3. If you followed the Home Assistant Configuration above, the default sensor name should match and the card should already display your images

# Troubleshooting

## Optimize images
When uploading from iOS Home Assistant Companion App, you can use the iOS built-in resize option in the Photo picker to let iOS resize images (e.g. to "Large" is suitable for most cases) before uploading them to Home Assistant:

![iOS resize image option](docs/images/ios-resize.gif)

## Errors
- Resolving web url path for: media-source://media_source/media/photo-frame-images/IMG_1234.heic
  - `{code: "resolve_media_failed", message: "Unknown source directory."}`
    - Check your `media_dirs` configuration and make sure that `media: /media` is present
