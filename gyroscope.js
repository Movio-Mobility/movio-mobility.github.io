/**
 * Gyroscope-based hover effects for mobile devices
 * This script detects mobile devices and uses the gyroscope to simulate hover effects
 * while preserving the existing desktop hover experience.
 */

document.addEventListener('DOMContentLoaded', () => {
    // Only apply gyroscope effects on mobile devices
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    if (!isMobile) {
        // Not a mobile device, don't apply gyroscope effects
        return;
    }
    
    // Create a container for gyroscope controls
    const gyroControlsContainer = document.createElement('div');
    gyroControlsContainer.classList.add('gyro-controls');
    gyroControlsContainer.style.position = 'fixed';
    gyroControlsContainer.style.bottom = '20px';
    gyroControlsContainer.style.left = '50%';
    gyroControlsContainer.style.transform = 'translateX(-50%)';
    gyroControlsContainer.style.zIndex = '9999';
    gyroControlsContainer.style.display = 'flex';
    gyroControlsContainer.style.flexDirection = 'column';
    gyroControlsContainer.style.alignItems = 'center';
    gyroControlsContainer.style.gap = '10px';
    
    // Check if device has gyroscope
    if (window.DeviceOrientationEvent && typeof window.DeviceOrientationEvent.requestPermission === 'function') {
        // iOS 13+ requires permission
        const permissionButton = document.createElement('button');
        permissionButton.innerText = 'Enable Premium Effects';
        permissionButton.classList.add('gyro-permission-button');
        permissionButton.style.padding = '10px 20px';
        permissionButton.style.backgroundColor = '#98C082';
        permissionButton.style.color = 'white';
        permissionButton.style.border = 'none';
        permissionButton.style.borderRadius = '5px';
        permissionButton.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)';
        permissionButton.style.fontFamily = 'DM Sans, sans-serif';
        permissionButton.style.fontSize = '14px';
        
        permissionButton.addEventListener('click', () => {
            window.DeviceOrientationEvent.requestPermission()
                .then(permissionState => {
                    if (permissionState === 'granted') {
                        // Permission granted, initialize gyroscope
                        initGyroscope();
                        permissionButton.remove();
                        
                        // Add calibration button after permission is granted
                        addCalibrationButton(gyroControlsContainer);
                    }
                })
                .catch(console.error);
        });
        
        gyroControlsContainer.appendChild(permissionButton);
        document.body.appendChild(gyroControlsContainer);
    } else if (window.DeviceOrientationEvent) {
        // Android and other devices that don't require permission
        initGyroscope();
        
        // Add calibration button directly
        addCalibrationButton(gyroControlsContainer);
        document.body.appendChild(gyroControlsContainer);
    }
});

function addCalibrationButton(container) {
    const calibrateButton = document.createElement('button');
    calibrateButton.innerText = 'Calibrate Effects';
    calibrateButton.classList.add('gyro-calibrate-button');
    calibrateButton.style.padding = '8px 16px';
    calibrateButton.style.backgroundColor = '#333';
    calibrateButton.style.color = 'white';
    calibrateButton.style.border = 'none';
    calibrateButton.style.borderRadius = '5px';
    calibrateButton.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)';
    calibrateButton.style.fontFamily = 'DM Sans, sans-serif';
    calibrateButton.style.fontSize = '12px';
    
    calibrateButton.addEventListener('click', () => {
        // Reset calibration
        window.gyroCalibration = {
            betaOffset: 0,
            gammaOffset: 0,
            isCalibrating: true,
            samples: []
        };
        
        // Show calibration message
        const calibrationMsg = document.createElement('div');
        calibrationMsg.innerText = 'Hold device flat and still...';
        calibrationMsg.style.backgroundColor = 'rgba(0,0,0,0.7)';
        calibrationMsg.style.color = 'white';
        calibrationMsg.style.padding = '15px';
        calibrationMsg.style.borderRadius = '5px';
        calibrationMsg.style.position = 'fixed';
        calibrationMsg.style.top = '50%';
        calibrationMsg.style.left = '50%';
        calibrationMsg.style.transform = 'translate(-50%, -50%)';
        calibrationMsg.style.zIndex = '10000';
        calibrationMsg.style.fontFamily = 'DM Sans, sans-serif';
        
        document.body.appendChild(calibrationMsg);
        
        // Collect samples for 2 seconds
        setTimeout(() => {
            window.gyroCalibration.isCalibrating = false;
            
            // Calculate average offsets
            if (window.gyroCalibration.samples.length > 0) {
                const sampleCount = window.gyroCalibration.samples.length;
                const betaSum = window.gyroCalibration.samples.reduce((sum, sample) => sum + sample.beta, 0);
                const gammaSum = window.gyroCalibration.samples.reduce((sum, sample) => sum + sample.gamma, 0);
                
                window.gyroCalibration.betaOffset = betaSum / sampleCount;
                window.gyroCalibration.gammaOffset = gammaSum / sampleCount;
            }
            
            // Remove calibration message
            document.body.removeChild(calibrationMsg);
            
            // Show success message
            const successMsg = document.createElement('div');
            successMsg.innerText = 'Calibration complete!';
            successMsg.style.backgroundColor = 'rgba(152,192,130,0.9)';
            successMsg.style.color = 'white';
            successMsg.style.padding = '15px';
            successMsg.style.borderRadius = '5px';
            successMsg.style.position = 'fixed';
            successMsg.style.top = '50%';
            successMsg.style.left = '50%';
            successMsg.style.transform = 'translate(-50%, -50%)';
            successMsg.style.zIndex = '10000';
            successMsg.style.fontFamily = 'DM Sans, sans-serif';
            
            document.body.appendChild(successMsg);
            
            // Remove success message after 2 seconds
            setTimeout(() => {
                document.body.removeChild(successMsg);
            }, 2000);
        }, 2000);
    });
    
    container.appendChild(calibrateButton);
}

function initGyroscope() {
    // Initialize calibration data
    window.gyroCalibration = {
        betaOffset: 0,
        gammaOffset: 0,
        isCalibrating: false,
        samples: []
    };
    
    // Store all elements that have hover effects
    const hoverElements = {
        boxes: document.querySelectorAll('.box'),
        premiumCards: document.querySelectorAll('.premium-card'),
        premiumCardsWide: document.querySelectorAll('.premium-card-wide'),
        featuresCards: document.querySelectorAll('.premium-card-features'),
        forgingCards: document.querySelectorAll('.forging-card'),
        calculatorCards: document.querySelectorAll('.calculator-card'),
        featureCards: document.querySelectorAll('.feature-card'),
        speedCards: document.querySelectorAll('.speed-card'),
        // Add more element types from other pages
        premiumOriginCards: document.querySelectorAll('.premium-origin-card'),
        premiumTeamCards: document.querySelectorAll('.premium-team-card'),
        timelineComponents: document.querySelectorAll('.timeline-component'),
        unifiedCards: document.querySelectorAll('.unified-card')
    };
    
    // Add gyroscope event listener
    window.addEventListener('deviceorientation', handleGyroscope);
    
    // Handle gyroscope data
    function handleGyroscope(event) {
        // Get gyroscope data
        const beta = event.beta;  // -180 to 180 (front-to-back tilt)
        const gamma = event.gamma; // -90 to 90 (left-to-right tilt)
        
        // If calibrating, collect samples
        if (window.gyroCalibration.isCalibrating) {
            window.gyroCalibration.samples.push({ beta, gamma });
            return;
        }
        
        // Apply calibration offsets
        const calibratedBeta = beta - window.gyroCalibration.betaOffset;
        const calibratedGamma = gamma - window.gyroCalibration.gammaOffset;
        
        // Detect device orientation
        const isPortrait = window.innerHeight > window.innerWidth;
        
        // Normalize values to percentages (similar to mouse position)
        let x, y;
        
        if (isPortrait) {
            // Portrait mode
            // Map beta from -30 to 30 degrees to 0-100%
            y = Math.max(0, Math.min(100, ((calibratedBeta + 30) / 60) * 100));
            // Map gamma from -30 to 30 degrees to 0-100%
            x = Math.max(0, Math.min(100, ((calibratedGamma + 30) / 60) * 100));
        } else {
            // Landscape mode
            // In landscape, gamma affects vertical tilt and beta affects horizontal
            y = Math.max(0, Math.min(100, ((calibratedGamma + 30) / 60) * 100));
            x = Math.max(0, Math.min(100, ((calibratedBeta + 30) / 60) * 100));
            
            // Adjust based on specific landscape orientation
            if (window.orientation === 90) {
                // Landscape right
                x = 100 - x;
            }
        }
        
        // Apply effects to all elements with different intensities
        applyEffectToElements(hoverElements.boxes, x, y, 0.1);
        applyEffectToElements(hoverElements.premiumCards, x, y, 0.1);
        applyEffectToElements(hoverElements.premiumCardsWide, x, y, 0.05);
        applyEffectToElements(hoverElements.featuresCards, x, y, 0.05);
        applyEffectToElements(hoverElements.forgingCards, x, y, 0.05);
        applyEffectToElements(hoverElements.calculatorCards, x, y, 0.05);
        applyEffectToElements(hoverElements.featureCards, x, y, 0.05);
        applyEffectToElements(hoverElements.speedCards, x, y, 0.05);
        applyEffectToElements(hoverElements.premiumOriginCards, x, y, 0.1);
        applyEffectToElements(hoverElements.premiumTeamCards, x, y, 0.1);
        applyEffectToElements(hoverElements.timelineComponents, x, y, 0.05);
        applyEffectToElements(hoverElements.unifiedCards, x, y, 0.1);
    }
    
    // Apply effect to a collection of elements
    function applyEffectToElements(elements, x, y, intensity) {
        elements.forEach(element => {
            // Skip if element is not visible in viewport
            if (!isElementInViewport(element)) {
                return;
            }
            
            // Set CSS variables for hover effects
            element.style.setProperty('--mouse-x', `${x}%`);
            element.style.setProperty('--mouse-y', `${y}%`);
            
            // Apply 3D tilt effect
            const rotateY = (x - 50) * intensity;
            const rotateX = (y - 50) * -intensity;
            
            element.style.transform = `
                rotateX(${rotateX}deg)
                rotateY(${rotateY}deg)
                translateZ(0)
            `;
        });
    }
    
    // Check if element is in viewport
    function isElementInViewport(el) {
        const rect = el.getBoundingClientRect();
        return (
            rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
            rect.bottom >= 0 &&
            rect.left <= (window.innerWidth || document.documentElement.clientWidth) &&
            rect.right >= 0
        );
    }
    
    // Add touch event listeners to simulate mouseleave when touching outside elements
    document.addEventListener('touchstart', (e) => {
        let touchedHoverElement = false;
        
        // Check if touch is on a hover element
        Object.values(hoverElements).forEach(collection => {
            collection.forEach(element => {
                if (element.contains(e.target)) {
                    touchedHoverElement = true;
                }
            });
        });
        
        // If touch is not on a hover element, reset all elements
        if (!touchedHoverElement) {
            resetAllElements(hoverElements);
        }
    });
    
    // Listen for orientation changes
    window.addEventListener('orientationchange', () => {
        // Reset calibration when orientation changes
        window.gyroCalibration = {
            betaOffset: 0,
            gammaOffset: 0,
            isCalibrating: false,
            samples: []
        };
    });
}

// Reset all elements to their default state
function resetAllElements(hoverElements) {
    Object.values(hoverElements).forEach(collection => {
        collection.forEach(element => {
            element.style.transform = 'rotateX(0) rotateY(0) translateZ(0)';
        });
    });
} 