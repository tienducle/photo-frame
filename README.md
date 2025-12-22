# PhotoFrame
#### A custom photo frame card for Home Assistant

![Automatic slideshow](docs/images/preview2.gif)
![Manual navigation](docs/images/manual-navigation.gif)

# Features

- Images are accessed using [Media source](https://www.home-assistant.io/integrations/media_source/) integration
  - *"Files served from `media` are protected by Home Assistant authentication unlike those served from `www`."*
- Navigate back and forth within recent images
- Works with Home Assistant Section, Masonry and Single-Panel layouts
- NEW: Improved support for existing (large) image collections (requires [ha-media-files custom integration](https://github.com/tienducle/ha-media-files))
- Other:
  - Configurable slideshow interval
  - Configurable delay when manually navigating
  - Crossfade transition
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

## Home Assistant managed image collection

This works best for new image collections, where you (and your household members) want to upload images via Home Assistant Media Browser panel.

1. Upload some images to your `/media/photo-frame-images` folder
2. Add PhotoFrame card to your dashboard
3. If you followed the Home Assistant Configuration above, the default sensor name should match and the card should already display your images

## Other image collections

The default [HA folder integration](https://www.home-assistant.io/integrations/folder/) does not support nested folders and is marked as legacy. To work with larger image collections that have subfolders, use the [ha-media-files](https://github.com/tienducle/ha-media-files) custom integration instead.

1. Follow instructions at [ha-media-files](https://github.com/tienducle/ha-media-files) to install the custom integration

2. Open the PhotoFrame card configuration and:
   - Enable the `Use custom media_files integration` option
   - Enter the path to your media folder, e.g. `/media/photo-frame-images`

The integration will automatically scan all subfolders recursively.

### Example: Using a network share

To use images from a NAS or network share:

   - Open `Home Assistant -> Settings -> System -> Storage`
   - Click `Add network storage`
   - Enter name: `my-nas-photo-collection`
   - Select usage: `Media`
   - Configure server, remote share, and credentials
   - Click `Save`

The folder will appear in the Media Browser panel. In PhotoFrame, set the media folder path to `/media/my-nas-photo-collection` or just `my-nas-photo-collection`.

**Note:** Paths outside the `/media` directory are not allowed by Home Assistant.

# Troubleshooting

## Optimize images
When uploading from the iOS Home Assistant Companion App, you can use the iOS built-in resize option in the Photo picker to resize images (e.g., selecting "Large" is suitable for most cases) before uploading them to Home Assistant:

![iOS resize image option](docs/images/ios-resize.gif)

## Errors
- Resolving web url path for: media-source://media_source/media/photo-frame-images/IMG_1234.heic
  - `{code: "resolve_media_failed", message: "Unknown source directory."}`
    - Check your `media_dirs` configuration and make sure that `media: /media` is present
