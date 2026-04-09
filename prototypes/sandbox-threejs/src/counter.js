// ============================================================================
// File: counter.js
// Purpose: Basic Vite counter module (skeleton/demo).
// Description:
//   A simple function to set up a click counter on an HTML element.
// ============================================================================

export function setupCounter(element) {
  let counter = 0
  
  // Updates the element's text and internal state
  const setCounter = (count) => {
    counter = count
    element.innerHTML = `Count is ${counter}`
  }
  
  // Bind click event to increment counter
  element.addEventListener('click', () => setCounter(counter + 1))
  
  // Initialize counter to 0
  setCounter(0)
}
