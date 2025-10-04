const DEFAULT_CONFIG = {
    hide_card_header          : false,
    card_header               : "PhotoFrame",
    card_mode                 : "grid",
    images_sensor             : 'sensor.photo_frame_images',
    slide_show_interval       : 2000,
    slide_show_mode           : "random",
    delay_on_manual_navigation: 10000,
    aspect_ratio              : '3/2',
    file_type_filter          : 'jpg,jpeg,png,gif,webp,heic',
    file_type_filter_regexp   : undefined,
    debug_logs_enabled        : false,
    start_immediately         : false,
    fade_duration             : 1000,
    max_history_size          : 10,
    grid_options              : {
        columns: 12,
        rows   : "auto"
    }
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

        // references to DOM elements
        this._cardContainerRef = null;
        this._helpTextContainerRef = null;
        this._photoContainerRef = null;
        this._currentImageElementRef = null;
        this._nextImageElementRef = null;
        this._isImageTransitioning = false;
        this._currentTransitionResolve = null;
        this._currentFadeDuration = 0;

        // Timer for auto-hiding navigation on touch
        this._transitionTimer = null;
        this._navHideTimer = null;

        // Store bound event handler references for cleanup
        this._mouseEnterEventHandler = null;
        this._mouseLeaveEventHandler = null;
        this._touchStartEventHandler = null;
        this._prevButtonClickedEventHandler = null;
        this._nextButtonClickedEventHandler = null;
        this._prevButtonRef = null;
        this._nextButtonRef = null;
    }

    /**
     * Called by Home Assistant on every state change
     *
     * @param hass
     */
    set hass( hass )
    {
        if ( !this._config )
        {
            return;
        }

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
               .then( state => this.saveState( state ) )
               .then( state => this.updateCardContainerContent( state ).then( () => state ) )
               .catch( error =>
               {
                   console.error( "Error while updating PhotoFrame card: ", error );
               } );
    }

    disconnectedCallback()
    {
        this.log( "Clean up" );

        // Clear all timers
        if ( this._navHideTimer )
        {
            clearTimeout( this._navHideTimer );
            this._navHideTimer = null;
        }

        if ( this._transitionTimer )
        {
            clearTimeout( this._transitionTimer );
            this._transitionTimer = null;
        }

        // Cancel any ongoing transitions
        if ( this._isImageTransitioning )
        {
            this._isImageTransitioning = false;
            if ( this._currentTransitionResolve )
            {
                this._currentTransitionResolve();
                this._currentTransitionResolve = null;
            }
        }

        if ( this._currentImageElementRef )
        {
            this._currentImageElementRef.onload = null;
            this._currentImageElementRef.onerror = null;
            this._currentImageElementRef.src = '';
            this._currentImageElementRef = null;
        }

        if ( this._nextImageElementRef )
        {
            this._nextImageElementRef.onload = null;
            this._nextImageElementRef.onerror = null;
            this._nextImageElementRef.src = '';
            this._nextImageElementRef = null;
        }

        if ( this._prevButtonRef )
        {
            this._prevButtonRef.removeEventListener( 'click', this._prevButtonClickedEventHandler );
            this._prevButtonClickedEventHandler = null;
            this._prevButtonRef = null;
        }

        if ( this._nextButtonRef )
        {
            this._nextButtonRef.removeEventListener( 'click', this._nextButtonClickedEventHandler );
            this._nextButtonClickedEventHandler = null;
            this._nextButtonRef = null;
        }

        if ( this._photoContainerRef )
        {
            this._photoContainerRef.removeEventListener( 'mouseenter', this._mouseEnterEventHandler );
            this._mouseEnterEventHandler = null;
            this._photoContainerRef.removeEventListener( 'mouseleave', this._mouseLeaveEventHandler );
            this._mouseLeaveEventHandler = null;
            this._photoContainerRef.removeEventListener( 'touchstart', this._touchStartEventHandler );
            this._touchStartEventHandler = null;
            this._photoContainerRef.remove();
            this._photoContainerRef = null;
        }

        if ( this._cardContainerRef )
        {
            this._cardContainerRef.remove();
            this._cardContainerRef = null;
        }

        this._imageList = [];
        this._indexHistory = [];
        this._indexOffset = 0;
        this._imageListSensorLastChanged = "";

        // Reset update flags
        this._isUpdateInProgress = false;
        this._lastUpdatedTimestamp = 0;

        this._hass = null;
    }

    /**
     * Initializes the card
     */
    initializeCardContainer()
    {
        this.log( "Initializing PhotoFrame card container..." );
        this.innerHTML = `
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

        this._cardContainerRef = this.querySelector( ".card-content" );
        this._helpTextContainerRef = this.querySelector( ".help-text-container" );
        this._config.file_type_filter_regexp = new RegExp( `\\.(${this._config.file_type_filter.split(',').join('|')})$`, "i" );
        if ( this._config.start_immediately === false )
        {
            // for debugging, skip first update and show the initial card
            this.log( "Start immediately is disabled, skipping first update interval" );
            this._lastUpdatedTimestamp = Date.now();
        }
        this.log( "PhotoFrame container initialized" );
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
        this._photoContainerRef = document.createElement( "div" );
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
        this._prevButtonRef = ImageNavButton.create( 'Previous image', 'left', '‹' );
        this._nextButtonRef = ImageNavButton.create( 'Next image', 'right', '›' );

        // Store bound handlers for cleanup
        this._prevButtonClickedEventHandler = () => this.previousButtonPressedHandler();
        this._nextButtonClickedEventHandler = () => this.nextButtonPressedHandler();

        this._prevButtonRef.addEventListener( 'click', this._prevButtonClickedEventHandler );
        this._nextButtonRef.addEventListener( 'click', this._nextButtonClickedEventHandler );

        // Create image element
        this._currentImageElementRef = new Image();
        this._currentImageElementRef.style.width = '100%';
        this._currentImageElementRef.style.height = '100%';
        this._currentImageElementRef.style.position = 'absolute';
        this._currentImageElementRef.style.top = '0';
        this._currentImageElementRef.style.left = '0';
        this._currentImageElementRef.style.transition = `opacity ${this._config.fade_duration}ms ease-in-out`;
        this._currentImageElementRef.style.opacity = '1';
        this._currentImageElementRef.style.zIndex = '1';
        this._currentImageElementRef.style.willChange = 'opacity';

        // Create image element for crossfade
        this._nextImageElementRef = new Image();
        this._nextImageElementRef.style.width = '100%';
        this._nextImageElementRef.style.height = '100%';
        this._nextImageElementRef.style.position = 'absolute';
        this._nextImageElementRef.style.top = '0';
        this._nextImageElementRef.style.left = '0';
        this._nextImageElementRef.style.transition = `opacity ${this._config.fade_duration}ms ease-in-out`;
        this._nextImageElementRef.style.opacity = '0';
        this._nextImageElementRef.style.zIndex = '2';
        this._nextImageElementRef.style.willChange = 'opacity';

        // Apply object-fit based on card mode
        const objectFitValue = this._config.card_mode === "grid"
                                      ? "cover"
                                      : this._config.card_mode === "single-card-panel"
                                        ? "contain"
                                        : this._config.card_mode;

        this._currentImageElementRef.style.objectFit = objectFitValue;
        this._nextImageElementRef.style.objectFit = objectFitValue;

        const onImageLoad = () =>
        {
            this.log( `Image was loaded. Starting transition.` );

            // Check if transition was cancelled (e.g., by manual navigation)
            if ( !this._isImageTransitioning )
            {
                this.log( `Transition was already cancelled` );
                if ( this._currentTransitionResolve )
                {
                    const resolve = this._currentTransitionResolve;
                    this._currentTransitionResolve = null;
                    resolve();
                }
                return;
            }

            this._currentImageElementRef.style.opacity = '0';
            this._nextImageElementRef.style.opacity = '1';

            // After transition completes, swap the elements
            this._transitionTimer = setTimeout(() =>
            {
                // Check again if transition was cancelled during the fade
                if ( !this._isImageTransitioning )
                {
                    this.log( `Transition was cancelled` );
                    if ( this._currentTransitionResolve )
                    {
                        const resolve = this._currentTransitionResolve;
                        this._currentTransitionResolve = null;
                        resolve();
                    }
                    return;
                }

                // Swap the image elements
                const temp = this._currentImageElementRef;
                this._currentImageElementRef = this._nextImageElementRef;
                this._nextImageElementRef = temp;

                // Reset z-index and opacity
                this._currentImageElementRef.style.zIndex = '1';
                this._currentImageElementRef.style.opacity = '1';
                this._nextImageElementRef.style.zIndex = '2';
                this._nextImageElementRef.style.opacity = '0';

                this._isImageTransitioning = false;
                this._transitionTimer = null;
                this._lastUpdatedTimestamp = Date.now();
                this._isUpdateInProgress = false;

                const resolve = this._currentTransitionResolve;
                this._currentTransitionResolve = null;
                resolve();
                this.log( `Transition completed` );

            }, this._currentFadeDuration );
        };

        const onImageLoadError = () =>
        {
            this._isImageTransitioning = false;
            this._transitionTimer = null;
            this._isUpdateInProgress = false;
            this.log( `Failed to load image` );
            if ( this._currentTransitionResolve )
            {
                const resolve = this._currentTransitionResolve;
                this._currentTransitionResolve = null;
                resolve();
            }
        };

        // Attach handlers to both image elements since they get swapped
        this._currentImageElementRef.onload = onImageLoad;
        this._currentImageElementRef.onerror = onImageLoadError;
        this._nextImageElementRef.onload = onImageLoad;
        this._nextImageElementRef.onerror = onImageLoadError;

        // Add image elements to photo container
        this._photoContainerRef.appendChild( this._currentImageElementRef );
        this._photoContainerRef.appendChild( this._nextImageElementRef );
        // Add buttons to photo container
        this._photoContainerRef.appendChild( this._prevButtonRef );
        this._photoContainerRef.appendChild( this._nextButtonRef );
        // Add photo container to main card container
        this._cardContainerRef.appendChild( this._photoContainerRef );

        // Setup event handlers for showing/hiding buttons (store references for cleanup)
        this._mouseEnterEventHandler = () => Promise
            .resolve()
            .then( () => this.getCurrentState() )
            .then( state => this.updateNavigationButtons( state, this._prevButtonRef, this._nextButtonRef, true ) );

        this._mouseLeaveEventHandler = () => Promise
            .resolve()
            .then( () => this.getCurrentState() )
            .then( state => this.updateNavigationButtons( state, this._prevButtonRef, this._nextButtonRef, false ) );

        this._touchStartEventHandler = ( domEvent ) =>
        {
            domEvent.stopPropagation();
            Promise.resolve()
                   .then( () => this.getCurrentState() )
                   .then( state =>
                   {
                       this.updateNavigationButtons( state, this._prevButtonRef, this._nextButtonRef, true );
                       if ( this._navHideTimer )
                       {
                           clearTimeout( this._navHideTimer );
                       }
                       this._navHideTimer = setTimeout( () =>
                       {
                           this.updateNavigationButtons( state, this._prevButtonRef, this._nextButtonRef, false );
                       }, 2500 );
                   } );
        };

        this._photoContainerRef.addEventListener( 'mouseenter', this._mouseEnterEventHandler );
        this._photoContainerRef.addEventListener( 'mouseleave', this._mouseLeaveEventHandler );
        this._photoContainerRef.addEventListener( 'touchstart', this._touchStartEventHandler, { passive: true } );

        this._helpTextContainerRef.remove();
        this._helpTextContainerRef = null;
    }

    /**
     * Updates the content of the card to display the current image.
     *
     * @param state {State}
     * @param isManualNavigation {boolean} Whether this is manual navigation (button click)
     * @returns {Promise<void>}
     */
    async updateCardContainerContent( state, isManualNavigation = false )
    {
        return this.resolveWebUrlPath( state.imageList[ state.indexHistory[ state.indexHistory.length - 1 - state.indexOffset ] ] )
                   .then( webUrlPath => this.prepareImageTransition( webUrlPath, isManualNavigation ) )
                   .then( transitionParams => this.triggerImageLoadAndTransition( transitionParams.webUrlPath, transitionParams.fadeDuration ) );
    }

    /**
     * Prepares images transition by determining the fade duration and setting up the image parameters
     *
     * @param webUrlPath {string}
     * @param isManualNavigation {boolean}
     * @returns {Promise<{webUrlPath: string, fadeDuration: number}>}
     */
    async prepareImageTransition( webUrlPath, isManualNavigation )
    {
        if ( this._isImageTransitioning )
        {
            this.log( `Skipping transition (already in progress)` );
            return { webUrlPath: webUrlPath, fadeDuration: -1 };
        }

        // Determine fade duration based on navigation type
        const fadeDuration = isManualNavigation
            ? 50
            : this._config.fade_duration;

        // If fade duration is 0, update immediately without fade effect
        if ( fadeDuration === 0 )
        {
            this._currentImageElementRef.src = webUrlPath;
            this._currentImageElementRef.style.opacity = '1';
            this._nextImageElementRef.style.opacity = '0';
            this._lastUpdatedTimestamp = Date.now();
            this._isUpdateInProgress = false;
            this.log( `Skipping transition (disabled)` );
        }

        return { webUrlPath: webUrlPath, fadeDuration: fadeDuration };
    }

    /**
     * Triggers loading of next image.
     * After the image is loaded, onImageLoad will handle the transition.
     *
     * @param webUrlPath {string}
     * @param fadeDuration {number}
     * @returns {Promise<void>}
     */
    async triggerImageLoadAndTransition( webUrlPath, fadeDuration )
    {
        if ( fadeDuration === -1 )
        {
            return;
        }

        return new Promise( ( resolve ) =>
        {
            this.log( `Loading image (with transition duration of: ${fadeDuration}ms): ${webUrlPath}` );
            this._currentTransitionResolve = resolve;
            this._currentFadeDuration = fadeDuration;
            this._isImageTransitioning = true;
            this._currentImageElementRef.style.transition = `opacity ${fadeDuration}ms ease-in-out`;
            this._nextImageElementRef.style.transition = `opacity ${fadeDuration}ms ease-in-out`;
            this._nextImageElementRef.src = webUrlPath;
        } );
    }

    /* Navigation buttons */

    /**
     * Changes the visibility of navigation buttons.
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
     * Handles the next button press: gets current state, moves to next image, and updates UI.
     */
    async nextButtonPressedHandler()
    {
        return Promise.resolve()
                      .then( () => this.getCurrentState() )
                      .then( state =>
                      {
                          if ( state.indexOffset > 0 )
                          {
                              state.indexOffset--;
                              this.log( `Next button pressed. Current indexOffset: ${JSON.stringify( state.indexOffset )}` );
                              return this.cancelOngoingTransition()
                                         .then( () => this.updateCardContainerContent( state, true ) )
                                         .then( () =>
                                         {
                                             this.saveState( state );
                                             this._lastUpdatedTimestamp = Date.now() + this._config.delay_on_manual_navigation;
                                             return state;
                                         });
                          }
                          return state;
                      })
                      .then( state => this.updateNavigationButtons( state, this._prevButtonRef, this._nextButtonRef, true ) );
    }

    /**
     * Handles the previous button press: gets current state, moves to previous image, and updates UI.
     */
    async previousButtonPressedHandler()
    {
        return Promise.resolve()
                      .then( () => this.getCurrentState() )
                      .then( state =>
                      {
                          if ( state.indexOffset < state.indexHistory.length - 1 )
                          {
                              state.indexOffset++;
                              this.log( `Previous button pressed. Current indexOffset: ${JSON.stringify(state.indexOffset)}` );
                              return this.cancelOngoingTransition()
                                         .then( () => this.updateCardContainerContent( state, true ) )
                                         .then( () =>
                                         {
                                             this.saveState( state );
                                             this._lastUpdatedTimestamp = Date.now() + this._config.delay_on_manual_navigation;
                                             return state;
                                         });
                          }
                          return state;
                      })
                      .then( state => this.updateNavigationButtons( state, this._prevButtonRef, this._nextButtonRef, true ) );
    }

    /**
     * Cancels any ongoing transition and resets image states
     */
    async cancelOngoingTransition()
    {
        if ( this._isImageTransitioning )
        {
            this._isImageTransitioning = false;

            // clear any pending timeout
            if ( this._transitionTimer )
            {
                clearTimeout( this._transitionTimer );
                this._transitionTimer = null;
            }

            // resolve current promise and clear
            if ( this._currentTransitionResolve )
            {
                this._currentTransitionResolve();
                this._currentTransitionResolve = null;
            }

            // Reset image opacities to prevent visual glitches
            this._currentImageElementRef.style.opacity = '1';
            this._nextImageElementRef.style.opacity = '0';

            // Reset z-index to ensure proper layering
            this._currentImageElementRef.style.zIndex = '1';
            this._nextImageElementRef.style.zIndex = '2';

            this.log( `Cancelled ongoing transition` );
        }
    }

    /* Image list sensor */

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
            throw new Error( "Sensor not found: " + this._config.images_sensor );
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
        state.imageList = fileList.filter( file => cardConfig.file_type_filter_regexp.test( file ) )
                                  .sort( ( a, b ) => this.imageCompareFunction( a, b ) );
        state.indexHistory = [];
        state.imageListSensorLastChanged = sensor.last_changed;
        state.hasNewImages = true;
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
    pickNextImage( state, cardConfig )
    {
        if ( state.imageList.length === 0 )
        {
            throw new Error( "Image list is empty." );
        }

        if ( state.indexOffset > 0 )
        {
            this.log( "Picking next image from existing history" );
            state.indexOffset--;
            return state;
        }

        if ( state.indexHistory.length === state.imageList.length )
        {
            this.log( `History contains all ${state.imageList.length} available images. Removing oldest entry` );
            // ensures at least one image is not in history
            state.indexHistory.shift();
        }

        switch ( cardConfig.slide_show_mode )
        {
            case "name-ascending":
            case "name-descending":
                // first start, indexHistory will be empty
                if ( state.indexHistory.length === 0 || state.indexHistory[state.indexHistory.length - 1] === state.imageList.length - 1 )
                {
                    state.indexHistory.push( 0 );
                    break;
                }
                // otherwise, just increment
                state.indexHistory.push( ( state.indexHistory[state.indexHistory.length - 1] + 1 ) % state.imageList.length );
                break;
            case "random":
            default:
                let nextIndex;
                do
                {
                    nextIndex = Math.floor( Math.random() * state.imageList.length );
                } while ( nextIndex === state.indexHistory[state.indexHistory.length - 1] || state.indexHistory.includes( nextIndex ) )
                state.indexHistory.push( nextIndex );
                break;
        }

        if ( state.indexHistory.length > cardConfig.max_history_size )
        {
            this.log( `History size limit reached (${cardConfig.max_history_size}). Removing oldest entry` );
            state.indexHistory.shift();
        }

        return state;
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
        this.log( `Resolving web url path for: ${mediaUri}` );
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
        return new State( {
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
     * @return {State}
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
        return state;
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
    setConfig( userConfig )
    {
        this._config = {
            ...DEFAULT_CONFIG,
            ...userConfig,
        };

        console.log( '[PhotoFrame] Configuration:', this._config );

        if ( this._config.file_type_filter === "" )
        {
            throw new Error( `File type filter cannot be empty. Default types are ${DEFAULT_CONFIG.file_type_filter}` );
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
                            { name: "aspect_ratio", required: true, selector: { select: { options: [ "16/10", "16/9", "4/3", "3/2", "1/1", "2/3", "3/4", "9/16", "10/16" ], mode: "dropdown" } } }
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
                            { name: "fade_duration", required: true, selector: { number: { min: 0, step: 100, unit_of_measurement: "ms", mode: "box" } } },
                            { name: "delay_on_manual_navigation", required: true, selector: { number: { min: 1000, step: 500, unit_of_measurement: "ms", mode: "box" } } }
                        ]
                },
                { name: "file_type_filter", required: true, selector: { text: {} } },
                {
                    name: "",
                    type: "grid",
                    schema:
                        [
                            { name: "debug_logs_enabled", selector: { boolean: { } } },
                            { name: "start_immediately", selector: { boolean: { } } },
                            { name: "max_history_size", selector: { number: { min: 1, max: 10, step: 1, mode: "box" } } }
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
                if (schema.name === "hide_card_header") return "Hide Card Header";
                if (schema.name === "card_header") return "Card Header";
                if (schema.name === "card_mode") return "Card Mode";
                if (schema.name === "aspect_ratio") return "Aspect Ratio";
                if (schema.name === "images_sensor") return "Images Sensor Entity";
                if (schema.name === "slide_show_interval") return "Slide Show Interval";
                if (schema.name === "slide_show_mode") return "Slide Show Mode";
                if (schema.name === "fade_duration") return "Fade Duration";
                if (schema.name === "delay_on_manual_navigation") return "Delay on Manual Navigation";
                if (schema.name === "file_type_filter") return "File Type Filter";
                if (schema.name === "debug_logs_enabled") return "Debug Logs Enabled";
                if (schema.name === "start_immediately") return "Start Immediately";
                if (schema.name === "max_history_size") return "Maximum History Size";
                return undefined;
            },

            /**
             * This callback function will be called per form field,
             * allowing you to define longer helper text for the field, which will be displayed below the field.
             *
             * @param schema
             * @returns {undefined|string}
             */
            computeHelper: ( schema ) =>
            {
                switch ( schema.name )
                {
                    case "hide_card_header":
                        return "";
                    case "card_header":
                        return "Text to display in the card header";
                    case "card_mode":
                        return "'grid' can crop images while 'single-card-panel' will letterbox them";
                    case "aspect_ratio":
                        return "Aspect ratio of the display area (images are fit within this ratio).";
                    case "images_sensor":
                        return "Entity ID of the folder sensor that provides the list of images";
                    case "slide_show_interval":
                        return "Interval between photos in milliseconds";
                    case "slide_show_mode":
                        return "Order in which images should be picked";
                    case "fade_duration":
                        return "Duration of fade transition between images in milliseconds. Set to 0 to disable fade effect.";
                    case "delay_on_manual_navigation":
                        return "Delay in milliseconds after manual navigation before the slideshow resumes";
                    case "file_type_filter":
                        return "Comma-separated file extensions. HEIC is most likely only supported on Apple devices";
                    case "debug_logs_enabled":
                        return "Enable debug logs. Open the browser console to see the logs";
                    case "start_immediately":
                        return "Start the slideshow immediately after the card is loaded";
                    case "max_history_size":
                        return "Maximum number of images to keep in history for manual navigation. Set to 1 to disable manual navigation.";
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
            assertConfig: ( config ) =>
            {
                // throw new Error("Unsupported configuration.");
            }
        };
    }

    static getStubConfig()
    {
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
            rows    : this._config.grid_options.rows,
            columns : this._config.grid_options.columns,
            min_rows: 0, // should be dynamic based on columns value
            //max_rows: 0, // should be dynamic based on columns value
            min_columns: 3
            //max_columns: "full"
        };
    }
}

// other helpers
class State
{
    /**
     *
     * @param state {{imageList: string[]|undefined, indexHistory: number[]|undefined, indexOffset: number, imageListSensorLastChanged: string|undefined}}
     */
    constructor( state )
    {
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
        const btn = document.createElement( 'button' );
        btn.setAttribute( 'type', 'button' );
        btn.setAttribute( 'aria-label', ariaLabel );
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
        btn.style.zIndex = '10'; // Ensure buttons appear above images
        btn.textContent = text;
        btn.onmouseenter = () => btn.style.background = 'rgba(0,0,0,0.4)';
        btn.onmouseleave = () => btn.style.background = 'rgba(0,0,0,0.25)';
        return btn;
    }

    static setVisibility( btn, visible )
    {
        btn.style.opacity = visible
                            ? '1'
                            : '0';

        btn.style.pointerEvents = visible
                                  ? 'auto'
                                  : 'none';
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
