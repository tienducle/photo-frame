const DEFAULT_CONFIG = {
    hide_card_header: false,
    card_header: "PhotoFrame",
    card_mode: "grid",
    images_sensor: 'sensor.photo_frame_images',
    slide_show_interval: 2000,
    slide_show_mode: "random",
    delay_on_manual_navigation: 10000,
    aspect_ratio: '3/2',
    file_type_filter: 'jpg,jpeg,png,gif,webp,heic',
    file_type_filter_regexp: undefined,
    debug_logs_enabled: false,
    start_immediately: false,
    grid_options: {
        columns: 12,
        rows: "auto"
    },
    max_history_size: 10
};

class PhotoFrame extends HTMLElement
{
    constructor()
    {
        super();

        // timestamp of the last image rotation
        this._lastUpdatedTimestamp = 0;

        // true if an update is in progress
        // since we rely on Home Assistant to update the card,
        // we need to prevent multiple update attempts from happening at the same time
        this._isUpdateInProgress = false;

        // timestamp of the last image list sensor change
        this._imageListSensorLastChanged = "";
        // list of images extracted from the image list sensor
        this._imageList = [];
        // list of image indices that have been displayed
        this._indexHistory = [];
        this._indexOffset = 0;

        this._cardContainerRef = null;
        this._helpTextContainerRef = null;
        this._photoContainerRef = null;
        this._currentImageElementRef = null;

        // Timer for auto-hiding navigation on touch
        this._navHideTimer = null;
    }

    /**
     * Called by Home Assistant on every state change
     *
     * @param hass
     */
    set hass( hass )
    {
        this._hass = hass;

        // Card was not initialized yet
        if ( !this._cardContainerRef )
        {
            this.initializeCardContainer();
        }

        // If an update is in progress or the last update was less than the slide show interval ago, do nothing
        if ( this._isUpdateInProgress === true || Date.now() - this._lastUpdatedTimestamp < this._config.slide_show_interval )
        {
            return;
        }
        this._isUpdateInProgress = true;

        Promise.resolve()
            .then( () => this.initializePhotoContainer() )
            .then( () => this.getCurrentState() )
            .then( state => this.refreshImageList( hass, this._config, state ) )
            .then( state => this.pickNextImage( state, this._config ) )
            .then( state => this.updateCardContainerContent( state ).then( () => state ) )
            .then( state => this.saveState( state ) )
            .catch( error =>
            {
                console.error( "Error while updating PhotoFrame card: ", error );
            });
    }

    /**
     * Initializes the card
     */
    initializeCardContainer()
    {
        this.log( "Initializing PhotoFrame card container..." );
        this.innerHTML =
            `
            <ha-card header="${this._config.hide_card_header ? "" : this._config.card_header}">
                <div class="card-content">
                    <div class="help-text-container">
                        <p>Welcome to PhotoFrame!</p>
                        <p>This card displays a random image from the configured folder every ${this._config.slide_show_interval / 1000} seconds.</p>
                        <p>Setup instructions:</p>
                        <ol>
                            <li>configuration.yaml:</li>
                            <code style="background: #f5f5f5; padding: 4px 0">
                            homeassistant:<br>
                            &nbsp;&nbsp;media_dirs:<br>
                            &nbsp;&nbsp;&nbsp;&nbsp;media: /media<br>
                            sensor:<br>
                            &nbsp;&nbsp;- platform: folder<br>
                            &nbsp;&nbsp;&nbsp;&nbsp;folder: /media/photo-frame-images<br>
                            </code>
                            <br>
                            <li>Restart Home Assistant</li>
                            <br>
                            <li>Add images to /media/photo-frame-images/</li>
                        </ol>
                        ${ this._config.debug_logs_enabled === true
                ? `<br>
                                                   <p>Current configuration:</p>
                                                   <ul style="list-style-type: none; background: #f5f5f5; padding: 10px; border-radius: 4px; font-family: monospace; font-size: 12px;">
                                                   ${Object.entries(this._config)
                    .map(([ key, value ]) => `<li style="margin: 2px 0;"><strong>${key}:</strong>${typeof value === "object" ? JSON.stringify(value) : value}</li>`)
                    .join("")}
                                                   </ul>`
                : ""
            }
                    </div>
                </div>
            </ha-card>
        `;

        this._cardContainerRef = this.querySelector(".card-content");
        this._helpTextContainerRef = this.querySelector(".help-text-container");
        this._config.file_type_filter_regexp = new RegExp(`\\.(${this._config.file_type_filter.split(',').join('|')})$`, "i");
        if ( this._config.start_immediately === false )
        {
            // for debugging, skip first update and show the initial card
            this._lastUpdatedTimestamp = Date.now();
        }
    }

    /**
     * Updates the content of the card to display the current image.
     *
     * @param state
     * @returns {Promise<void>}
     */
    async updateCardContainerContent( state )
    {
        return this.resolveWebUrlPath( state.imageList[state.indexHistory[state.indexHistory.length - 1 - state.indexOffset]] )
            .then( webUrlPath => {
                // Update the image source
                this._currentImageElementRef.src = webUrlPath;
                this._lastUpdatedTimestamp = Date.now();
                this._isUpdateInProgress = false;
                this.log( `Updated image` );
            });
    }

    /**
     * Initializes the photo container and image element.
     * This only needs to be done once, when the card transitions from the help text to showing a photo.
     */
    initializePhotoContainer()
    {
        // On first update, create photo container and image element
        if ( this._photoContainerRef )
        {
            return;
        }

        this.log( "Initializing photo container" );

        // Create photo container
        this._photoContainerRef = document.createElement("div");
        this._photoContainerRef.className = "photo-container";
        this._photoContainerRef.style.aspectRatio = this._config.aspect_ratio || "16/9";
        this._photoContainerRef.style.width = "auto";
        this._photoContainerRef.style.height = "auto";
        this._photoContainerRef.style.overflow = "hidden";
        this._photoContainerRef.style.display = "flex";
        this._photoContainerRef.style.alignItems = "center";
        this._photoContainerRef.style.justifyContent = "center";
        this._photoContainerRef.style.position = "relative"; // for overlay buttons

        // Create navigation buttons
        const prevButtonRef = ImageNavButton.create('Previous image', 'left', '‹');
        const nextButtonRef = ImageNavButton.create('Next image', 'right', '›');

        prevButtonRef.addEventListener( 'click', () => Promise.resolve()
            .then( () => this.getCurrentState() )
            .then( state => this.previousButtonPressedHandler(state).then(() => ({state})))
            .then( ({state}) => this.updateNavigationButtons( state, prevButtonRef, nextButtonRef, true) )
        );
        nextButtonRef.addEventListener( 'click', () => Promise.resolve()
            .then( () => this.getCurrentState() )
            .then( state => this.nextButtonPressedHandler( state ).then(() => ({state})))
            .then( ({state}) => this.updateNavigationButtons( state, prevButtonRef, nextButtonRef, true) )
        );

        // Create image element
        this._currentImageElementRef = new Image();
        this._currentImageElementRef.style.width = '100%';
        this._currentImageElementRef.style.height = '100%';
        this._currentImageElementRef.style.display = 'flex';
        switch ( this._config.card_mode )
        {
            case "grid":
                this._currentImageElementRef.style.objectFit = "cover";
                break;
            case "single-card-panel":
                this._currentImageElementRef.style.objectFit = "contain";
                break;
            default:
                this._currentImageElementRef.style.objectFit = this._config.card_mode;
        }

        // Add image element to photo container
        this._photoContainerRef.appendChild( this._currentImageElementRef );
        // Add buttons to photo container
        this._photoContainerRef.appendChild( prevButtonRef );
        this._photoContainerRef.appendChild( nextButtonRef );
        // Add photo container to main card container
        this._cardContainerRef.appendChild( this._photoContainerRef );

        // Setup event handlers for showing/hiding buttons
        this._photoContainerRef.addEventListener( 'mouseenter', () => Promise.resolve()
            .then( () => this.getCurrentState() )
            .then( state => this.updateNavigationButtons( state, prevButtonRef, nextButtonRef, true ) ) );
        this._photoContainerRef.addEventListener( 'mouseleave', () => Promise.resolve()
            .then( () => this.getCurrentState() )
            .then( state => this.updateNavigationButtons( state, prevButtonRef, nextButtonRef, false ) ) );
        this._photoContainerRef.addEventListener( 'touchstart', (domEvent) =>
        {
            domEvent.stopPropagation();
            Promise.resolve()
                .then( () => this.getCurrentState() )
                .then( state => {
                    this.updateNavigationButtons( state, prevButtonRef, nextButtonRef, true )
                    if ( this._navHideTimer )
                    {
                        clearTimeout(this._navHideTimer);
                    }
                    this._navHideTimer = setTimeout(() =>
                    {
                        this.updateNavigationButtons( state, prevButtonRef, nextButtonRef, false );
                    }, 2500);
                });
        }, { passive: true });

        this._helpTextContainerRef.remove();
        delete this._helpTextContainerRef;
    }

    /**
     *
     * @param state {State}
     * @param prevButtonRef {HTMLButtonElement}
     * @param nextButtonRef {HTMLButtonElement}
     * @param visible {boolean}
     */
    updateNavigationButtons( state, prevButtonRef, nextButtonRef, visible )
    {
        if ( visible )
        {
            // prev button visible only if not at the first image
            ImageNavButton.setVisibility( prevButtonRef, state.indexOffset !== state.indexHistory.length - 1 );
            // next button is only visible if not at the last image
            ImageNavButton.setVisibility( nextButtonRef, state.indexOffset !== 0 );
        }
        else
        {
            ImageNavButton.setVisibility( prevButtonRef, false );
            ImageNavButton.setVisibility( nextButtonRef, false );
        }
    }

    /**
     * Immediately switch to next image in history if there is an image available.
     *
     * @param state {State}
     */
    async nextButtonPressedHandler( state )
    {
        if ( state.indexOffset > 0 )
        {
            state.indexOffset--;
            this.log( `Next button pressed. Current state: ${JSON.stringify(state.indexOffset)}` );
            return this.updateCardContainerContent( state ).then( () => {
                this.saveState( state )
                this._lastUpdatedTimestamp = Date.now() + this._config.delay_on_manual_navigation;
            });
        }
    }

    /**
     * Immediately switch to previous image in history if there is an image available.
     *
     * @param state {State}
     */
    async previousButtonPressedHandler( state )
    {
        if ( state.indexOffset < state.indexHistory.length - 1 )
        {
            state.indexOffset++;
            this.log( `Previous button pressed. Current state: ${JSON.stringify(state.indexOffset)}` );
            return this.updateCardContainerContent( state ).then( () => {
                this.saveState( state )
                this._lastUpdatedTimestamp = Date.now() + this._config.delay_on_manual_navigation;
            });
        }
    }

    /**
     * Given an internal image file path, builds a media_source uri:
     * - uri scheme: "media_source://media_source/<media_dir>/<path>"
     * - example:    "media_source://media_source/media/photo-frame-images/IMG_1234.jpeg)"
     * and calls the websocket api to resolve it to an accessible web uri.
     *
     * @param {string} internalImageFilePath
     * @returns {Promise<string>} Promise that resolves to a path with token as query parameter
     */
    async resolveWebUrlPath( internalImageFilePath )
    {
        const mediaUri = "media-source://media_source" + internalImageFilePath;
        this.log( `Resolving web url path for: ${mediaUri}` )
        return this._hass.callWS( {type: "media_source/resolve_media", media_content_id: mediaUri} )
            .then( response => response.url );
    }

    /**
     * Returns the current state of the card.
     *
     * @returns {State}
     */
    getCurrentState()
    {
        return new State(
            {
                imageList: [...this._imageList],
                indexHistory: [...this._indexHistory],
                indexOffset: this._indexOffset,
                imageListSensorLastChanged: this._imageListSensorLastChanged
            });
    }

    /**
     * Saves the given state to the internal state variables.
     *
     * @param state {State}
     */
    saveState( state )
    {
        this.log( "Saving state: ", state );
        if ( state.hasNewImages )
        {
            this._imageList = state.imageList;
        }
        this._indexHistory = state.indexHistory;
        this._indexOffset = state.indexOffset;
        this._imageListSensorLastChanged = state.imageListSensorLastChanged;
    }

    /**
     * If the image list sensor data differs from the current state, updates the state object with the current image list.
     *
     * @param hass
     * @param cardConfig
     * @param state {State}
     * @returns {State} List of image files
     */
    refreshImageList( hass, cardConfig, state )
    {
        /** @type {{entity_id: string, last_changed: string,attributes: {file_list: string[]}}} */
        const sensor = hass.states[ this._config.images_sensor ];
        if ( !sensor )
        {
            throw new Error("Sensor not found: " + this._config.images_sensor);
        }
        this.log( "Sensor state:", sensor );
        if ( sensor.last_changed === this._imageListSensorLastChanged )
        {
            this.log( "Image list sensor did not change." );
            return state;
        }

        this.log( "Retrieving image paths from image list sensor" );
        /** @type {string[]} */
        const fileList = sensor.attributes.file_list || [];

        state.imageList = fileList
            .filter( file => cardConfig.file_type_filter_regexp.test( file ) )
            .sort( ( a, b) => this.imageCompareFunction( a, b ) )
        state.hasNewImages = true;

        state.indexHistory = [];
        state.imageListSensorLastChanged = sensor.last_changed;
        return state;
    }

    imageCompareFunction( a, b )
    {
        switch ( this._config.slide_show_mode )
        {
            case "name-ascending":
                return a.localeCompare( b, undefined, { sensitivity: 'base', numeric: true } );
            case "name-descending":
                return b.localeCompare( a, undefined, { sensitivity: 'base', numeric: true } );
            case "random":
            default:
                return Math.random() - 0.5;
        }
    }

    /**
     * Picks the next image to display.
     *
     * @param state {State}
     * @param cardConfig {{slide_show_mode: string, max_history_size: number}}
     */
    pickNextImage(state, cardConfig )
    {
        if ( state.imageList.length === 0 )
        {
            throw new Error( "Image list is empty." );
        }

        if ( state.indexOffset > 0 )
        {
            state.indexOffset--;
            return state;
        }

        if ( state.indexHistory.length === state.imageList.length )
        {
            state.indexHistory.shift();
        }

        switch ( cardConfig.slide_show_mode )
        {
            case "name-ascending":
            case "name-descending":
                // first start, indexHistory will be empty
                if ( state.indexHistory.length === 0 || state.indexHistory[state.indexHistory.length - 1] === state.imageList.length - 1 )
                {
                    state.indexHistory.push(0);
                    break;
                }
                // otherwise, just increment
                state.indexHistory.push((state.indexHistory[state.indexHistory.length - 1] + 1) % state.imageList.length);
                break
            case "random":
            default:
                let nextIndex;
                do
                {
                    nextIndex = Math.floor(Math.random() * state.imageList.length);
                } while ( nextIndex === state.indexHistory[state.indexHistory.length - 1] || state.indexHistory.includes(nextIndex) )
                state.indexHistory.push(nextIndex);
                break;
        }

        if ( state.indexHistory.length > cardConfig.max_history_size )
        {
            state.indexHistory.shift();
        }

        return state;
    }

    disconnectedCallback() {
        this.log( "DisconnectedCallback" );
        clearTimeout(this._navHideTimer);
    }

    log( message, ...args )
    {
        if ( this._config?.debug_logs_enabled )
        {
            console.log( "[PhotoFrame] " + message, ...args );
        }
    }

    /* HA functions */

    // The user supplied configuration. Throw an exception and Home Assistant
    // will render an error card.
    setConfig(userConfig)
    {
        this._config = {
            ...DEFAULT_CONFIG,
            ...userConfig,
        };

        console.log( '[PhotoFrame] Configuration:', this._config );

        if ( this._config.file_type_filter === "" )
        {
            throw new Error(`File type filter cannot be empty. Default types are ${DEFAULT_CONFIG.file_type_filter}`);
        }
    }

    static getConfigForm()
    {
        return {
            /**
             * This is a list of schema objects, one per form field,
             * defining various properties of the field, like the name and selector
             */
            schema: [
                {
                    name: "",
                    type: "grid",
                    schema:
                        [
                            { name: "hide_card_header", selector: { boolean: { } } },
                        ]
                },
                {
                    name: "",
                    type: "grid",
                    schema:
                        [
                            { name: "card_header", selector: { text: {} } },
                            { name: "card_mode", required: true, selector: { select: { options: [ "grid", "single-card-panel" ], mode: "dropdown" } } },
                        ]
                },
                { name: "images_sensor", required: true, selector: { entity: { filter: { domain: "sensor", integration: "folder" } } } },
                {
                    name: "",
                    type: "grid",
                    schema:
                        [
                            { name: "slide_show_interval", required: true, selector: { number: { min: 1000, step: 500, unit_of_measurement: "ms", mode: "box" } } },
                            { name: "slide_show_mode", required: true, selector: { select: { options: [ "random", "name-ascending", "name-descending" ], mode: "dropdown" } } },
                            { name: "delay_on_manual_navigation", required: true, selector: { number: { min: 1000, step: 500, unit_of_measurement: "ms", mode: "box" } } },
                            { name: "aspect_ratio", required: true, selector: { select: { options: [ "16/10", "16/9", "4/3", "3/2", "1/1", "2/3", "3/4", "9/16", "10/16" ], mode: "dropdown" } } }
                        ]
                },
                { name: "file_type_filter", required: true, selector: { text: {} } },
                {
                    name: "",
                    type: "grid",
                    schema:
                        [
                            { name: "debug_logs_enabled", selector: { boolean: { } } },
                            { name: "start_immediately", selector: { boolean: { } } }
                        ]
                }
            ],

            /**
             * This callback function will be called per form field,
             * allowing the card to define the label that will be displayed for the field.
             * If undefined, Home Assistant may apply a known translation for generic field names like entity,
             * or you can supply your own translations.
             *
             * @param schema
             * @returns {undefined|string}
             */
            computeLabel: (schema) => {
                if (schema.name === "card_header") return "Card Header";
                if (schema.name === "card_mode") return "Card Mode";
                if (schema.name === "hide_card_header") return "Hide Card Header";
                if (schema.name === "images_sensor") return "Images Sensor Entity";
                if (schema.name === "slide_show_interval") return "Slide Show Interval";
                if (schema.name === "slide_show_mode") return "Slide Show Mode";
                if (schema.name === "delay_on_manual_navigation") return "Delay on Manual Navigation";
                if (schema.name === "aspect_ratio") return "Aspect Ratio";
                if (schema.name === "file_type_filter") return "File Type Filter";
                if (schema.name === "debug_logs_enabled") return "Debug Logs Enabled";
                if (schema.name === "start_immediately") return "Start Immediately";
                return undefined;
            },

            /**
             * This callback function will be called per form field,
             * allowing you to define longer helper text for the field, which will be displayed below the field.
             *
             * @param schema
             * @returns {undefined|string}
             */
            computeHelper: (schema) => {
                switch (schema.name) {
                    case "card_header":
                        return "Text to display in the card header";
                    case "card_mode":
                        return "'grid' can crop images while 'single-card-panel' will letterbox them";
                    case "hide_card_header":
                        return "";
                    case "images_sensor":
                        return "Entity ID of the folder sensor that provides the list of images";
                    case "slide_show_interval":
                        return "Interval between photos in milliseconds";
                    case "slide_show_mode":
                        return "Order in which images should be picked";
                    case "delay_on_manual_navigation":
                        return "Delay in milliseconds after manual navigation before the slideshow resumes";
                    case "aspect_ratio":
                        return "Aspect ratio of the display area (images are fit within this ratio).";
                    case "file_type_filter":
                        return "Comma-separated file extensions. HEIC is most likely only supported on Apple devices";
                    case "debug_logs_enabled":
                        return "Enable debug logs. Open the browser console to see the logs";
                    case "start_immediately":
                        return "Start the slideshow immediately after the card is loaded";
                }
                return undefined;
            },

            /**
             * On each update of the configuration, the user's config will be passed to this callback function.
             * If you throw an Error during this callback, the visual editor will be disabled.
             * This can be used to disable the visual editor when the user enters incompatible data,
             * like entering an object in yaml for a selector that expects a string.
             * If a subsequent execution of this callback does not throw an error,
             * the visual editor will be re-enabled
             *
             * @param config
             */
            assertConfig: (config) => {
                // throw new Error("Unsupported configuration.");
            }
        };
    }

    static getStubConfig() {
        return DEFAULT_CONFIG;
    }

    // The height of your card. Home Assistant uses this to automatically
    // distribute all cards over the available columns in masonry view
    getCardSize()
    {
        return 3;
    }

    // The rules for sizing your card in the grid in sections view
    getGridOptions()
    {
        return {
            //rows: "auto", // should be dynamic based on columns value
            rows: this._config.grid_options.rows,
            columns: this._config.grid_options.columns,
            min_rows: 0, // should be dynamic based on columns value
            //max_rows: 0, // should be dynamic based on columns value
            min_columns: 3
            //max_columns: "full"
        };
    }
}

// other helpers
class State {
    /**
     *
     * @param state {{imageList: string[]|undefined, indexHistory: number[]|undefined, indexOffset: number, imageListSensorLastChanged: string|undefined}}
     */
    constructor( state ) {
        this.imageList = state.imageList || [];
        this.indexHistory = state.indexHistory || [];
        this.indexOffset = state.indexOffset;
        this.imageListSensorLastChanged = state.imageListSensorLastChanged || "";
        this.hasNewImages = false;
    }
}

class ImageNavButton
{
    /**
     * Creates an image navigation button.
     *
     * @param ariaLabel {string} The aria label for the button.
     * @param side {string} left or right
     * @param text {string} The text to display on the button.
     * @returns {HTMLButtonElement}
     */
    static create( ariaLabel, side, text )
    {
        const btn = document.createElement('button');
        btn.setAttribute('type', 'button');
        btn.setAttribute('aria-label', ariaLabel);
        btn.style.position = 'absolute';
        btn.style.top = '50%';
        btn.style.transform = 'translateY(-50%)';
        btn.style[side] = '8px';
        btn.style.width = '48px';
        btn.style.height = '48px';
        btn.style.borderRadius = '9999px';
        btn.style.border = 'none';
        btn.style.cursor = 'pointer';
        btn.style.display = 'flex';
        btn.style.alignItems = 'center';
        btn.style.justifyContent = 'center';
        btn.style.background = 'rgba(0,0,0,0.25)';
        btn.style.color = '#fff';
        btn.style.fontSize = '22px';
        btn.style.lineHeight = '1';
        btn.style.padding = '0';
        btn.style.userSelect = 'none';
        btn.style.backdropFilter = 'blur(2px)';
        btn.style.transition = 'background 120ms ease-in-out';
        btn.style.opacity = '0';
        btn.style.pointerEvents = 'none';
        btn.textContent = text;
        btn.onmouseenter = () => {
            btn.style.background = 'rgba(0,0,0,0.4)';
        }
        btn.onmouseleave = () => {
            btn.style.background = 'rgba(0,0,0,0.25)';
        }
        return btn;
    }

    static setVisibility( btn, visible )
    {
        btn.style.opacity = visible ? '1' : '0';
        btn.style.pointerEvents = visible ? 'auto' : 'none';
    }
}

customElements.define( "photo-frame", PhotoFrame );

window.customCards = window.customCards || []
window.customCards.push({
    type: "photo-frame",
    name: "PhotoFrame",
    preview: false,
    description: "Displays a random image from a configured folder."
});
