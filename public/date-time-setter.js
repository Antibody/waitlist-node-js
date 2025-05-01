// date-time-setter.js
document.addEventListener('DOMContentLoaded', () => {
    const themeSwitcher = document.getElementById('theme-switcher');
    const loadingIndicator = document.getElementById('loading-indicator');
    const setupContainer = document.getElementById('setup-container');
    const launchForm = document.getElementById('launch-form');
    const dateInput = document.getElementById('launch-date');
    const timeInput = document.getElementById('launch-time');
    const submitButton = document.getElementById('submit-button');
    const errorMessageDiv = document.getElementById('error-message');
    const successMessageDiv = document.getElementById('success-message');

    let selectedDate = null;
    let selectedTime = null;
    let isDark = localStorage.getItem('darkMode') === 'true'; // Persist theme preference

    // --- Theme Handling ---
    const applyTheme = () => {
        if (isDark) {
            document.body.classList.add('dark-mode');
            themeSwitcher.textContent = '🌞'; // Sun icon for switching to light
        } else {
            document.body.classList.remove('dark-mode');
            themeSwitcher.textContent = '🌜'; // Moon icon for switching to dark
        }
        localStorage.setItem('darkMode', isDark);
    };

    themeSwitcher.addEventListener('click', () => {
        isDark = !isDark;
        applyTheme();
    });

    // Apply initial theme
    applyTheme();

    // --- Helper Functions ---
    const showMessage = (element, message) => {
        element.textContent = message;
        element.style.display = 'block';
    };

    const hideMessages = () => {
        errorMessageDiv.style.display = 'none';
        successMessageDiv.style.display = 'none';
    };

    const setLoadingState = (isLoading) => {
        submitButton.disabled = isLoading;
        submitButton.textContent = isLoading ? 'Setting...' : 'Set Launch Date & Time';
    };

    // --- Check Setup Status ---
    const checkSetup = async () => {
        // Use a relative URL so that the request goes to the current origin.
        const apiUrl = '/api/admin/check-setup-status';
        try {
            const response = await fetch(apiUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) {
                if (response.status === 401 || response.status === 403) {
                    window.location.href = '/login.html';
                    return;
                }
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            if (data.setupComplete) {
                // If setup is already done, redirect to admin page
                window.location.href = '/admin.html';
            } else {
                // Setup not complete, show the form
                loadingIndicator.style.display = 'none';
                setupContainer.style.display = 'block';
                initializePickers();
            }
        } catch (error) {
            console.error('Error checking setup status:', error);
            loadingIndicator.textContent = 'Error checking setup status. Please try refreshing.';
        }
    };

    // --- Initialize Date/Time Pickers ---
    const initializePickers = () => {
        flatpickr(dateInput, {
            altInput: true,
            altFormat: "F j, Y",
            dateFormat: "Y-m-d",
            minDate: "today",
            onChange: function(selectedDates) {
                selectedDate = selectedDates[0] || null;
                if (selectedDate && !selectedTime) {
                    const defaultTime = new Date(selectedDate);
                    defaultTime.setHours(9, 0, 0, 0);
                    timePicker.setDate(defaultTime, true);
                } else if (!selectedDate) {
                    timePicker.clear();
                }
            },
        });

        const timePicker = flatpickr(timeInput, {
            enableTime: true,
            noCalendar: true,
            dateFormat: "H:i",
            time_24hr: true,
            minuteIncrement: 15,
            defaultHour: 9,
            onChange: function(selectedDates) {
                selectedTime = selectedDates[0] || null;
            }
        });
    };

    // --- Form Submission ---
    launchForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        hideMessages();

        if (!selectedDate || !selectedTime) {
            showMessage(errorMessageDiv, 'Please select both a date and a time.');
            return;
        }

        const combinedLocalDateTime = new Date(selectedDate);
        combinedLocalDateTime.setHours(selectedTime.getHours(), selectedTime.getMinutes(), 0, 0);
        const launchDateISO = combinedLocalDateTime.toISOString();

        setLoadingState(true);
        // Use a relative URL for the validate endpoint
        const apiUrl = '/api/admin/validate';

        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ launchDate: launchDateISO })
            });

            const result = await response.json();

            if (!response.ok) {
                if (response.status === 401 || response.status === 403) {
                    window.location.href = '/login.html';
                    return;
                }
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            showMessage(successMessageDiv, result.message || 'Waitlist initialized successfully! Redirecting...');
            setTimeout(() => {
                window.location.href = '/admin.html';
            }, 2000);
        } catch (error) {
            console.error('Error initializing waitlist:', error);
            showMessage(errorMessageDiv, `Initialization failed: ${error.message}`);
            setLoadingState(false);
        }
    });

    // --- Initial Load ---
    checkSetup();
});
