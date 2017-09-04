'use strict';

const fs = require('fs');
const request = require('request');
const color = require('tinycolor2');
const black = color('black');

// Hue Bridge api endpoint
const hue_api = 'http://192.168.1.111/api';

// Hue Bridge username
const username = fs.readFileSync(`${process.env.HOME}/.hue_username`, { encoding: 'utf8' }).trim();

const leftLightId = 2;
const rightLightId = 1;

// Wait this many ms after successful Hue Bridge poll before polling again
const waitMs = 500;

// Number of leds in rgbd
const numLeds = 89;

// Framerate at which to send updates to rgbd
const framerate = 60;

// Address of rgbd server
const socket = require('socket.io-client')('http://localhost:9009');

let leds = [...Array(numLeds)].map(led => ({ r: 0, g: 0, b: 0 }));
let newColors = [...Array(numLeds)].map(led => color());
let oldTime = new Date().getTime();

/**
 * This function is a rough approximation of the reversal of RGB to xy transform. It is a gross approximation and does
 * get close, but is not exact.
 * @param x
 * @param y
 * @param brightness
 * @returns {Array} RGB values
 * @private
 *
 * This function is stolen from https://github.com/peter-murray/node-hue-api/blob/master/hue-api/rgb.js
 * which in turn is a modification of the one found at https://github.com/bjohnso5/hue-hacking/blob/master/src/colors.js#L251
 *
 * The last rgb.map() was modified not to round down to nearest integers, since rgbd supports
 * dithering of floating point values.
 */
const xyToRgb = (xy, brightness) => {
  const x = xy[0];
  const y = xy[1];

  var Y = brightness
    , X = (Y / y) * x
    , Z = (Y / y) * (1 - x - y)
    , rgb =  [
      X * 1.612 - Y * 0.203 - Z * 0.302,
      -X * 0.509 + Y * 1.412 + Z * 0.066,
      X * 0.026 - Y * 0.072 + Z * 0.962
    ];

  // Apply reverse gamma correction.
  rgb = rgb.map(function (x) {
    return (x <= 0.0031308) ? (12.92 * x) : ((1.0 + 0.055) * Math.pow(x, (1.0 / 2.4)) - 0.055);
  });

  // Bring all negative components to zero.
  rgb = rgb.map(function (x) { return Math.max(0, x); });

  // If one component is greater than 1, weight components by that value.
  var max = Math.max(rgb[0], rgb[1], rgb[2]);
  if (max > 1) {
    rgb = rgb.map(function (x) { return x / max; });
  }

  rgb = rgb.map(function (x) { return x * 255; });

  return color.fromRatio({
    r: rgb[0],
    g: rgb[1],
    b: rgb[2]
  });
}

// From pseudocode at http://www.tannerhelland.com/4435/convert-temperature-rgb-algorithm-code/
// Converts a temperature value in mired to rgb
const miredToRgb = (mired) => {
  let temp = 1000000 / mired;

  temp = temp / 100;

  let r, g, b;

  // Red
  if (temp <= 66) {
    r = 255;
  } else {
    r = temp - 60;
    r = 329.698727446 * Math.pow(r, -0.1332047592);
  }
  r = Math.min(255, Math.max(0, r));

  // Green
  if (temp <= 66) {
    g = temp;
    g = 99.4708025861 * Math.log(g) - 161.1195681661;
  } else {
    g = temp - 60;
    g = 288.1221695283 * Math.pow(g, -0.0755148492);
  }
  g = Math.min(255, Math.max(0, g));

  // Blue
  if (temp >= 66) {
    b = 255;
  } else {
    if (temp <= 19) {
      b = 0;
    } else {
      b = temp - 10;
      b = 138.5177312231 * Math.log(b) - 305.0447927307;
    }
  }
  b = Math.min(255, Math.max(0, b));

  return color({ r, g, b });
}

// Get color of single light bulb
const getColor = lamp => {
  let lampColor;

  if (!lamp.state.on) {
    lampColor = black;
  } else if (lamp.state.colormode === 'ct') {
    lampColor = miredToRgb(lamp.state.ct);
  } else if (lamp.state.colormode === 'xy') {
    lampColor = xyToRgb(lamp.state.xy, 1);
  } else {
    lampColor = black;
  }

  // Fade out according to brightness
  lampColor = color.mix(
    lampColor,
    black,
    (1 - lamp.state.bri / 254) * 80
  );

  return lampColor;
};

const pollColor = () => {
  request(`${hue_api}/${username}/lights`, (error, response, body) => {
    const parsedBody = JSON.parse(body);

    const leftLamp = parsedBody[leftLightId];
    const rightLamp = parsedBody[rightLightId];

    const leftColor = getColor(leftLamp);
    const rightColor = getColor(rightLamp);

    newColors = [...Array(numLeds)].map((led, index) =>
      color.mix(leftColor, rightColor, index / numLeds * 100)
    );

    setTimeout(pollColor, waitMs);
  });
};

pollColor();

setInterval(() => {
  const t = new Date().getTime();
  const weight = Math.pow(0.995, t - oldTime);

  leds = leds.map((led, index) => ({
    r: weight * led.r + (1 - weight) * newColors[index]._r,
    g: weight * led.g + (1 - weight) * newColors[index]._g,
    b: weight * led.b + (1 - weight) * newColors[index]._b,
  }));

  oldTime = new Date().getTime();

  socket.emit('frame', {
    id: 0,
    name: 'Hue',
    colors: leds
  });
}, 1 / framerate * 1000);
