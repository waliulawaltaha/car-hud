/// <reference types="web-bluetooth" />
import { 
  waitForEvenAppBridge, 
  CreateStartUpPageContainer, 
  TextContainerProperty,
  RebuildPageContainer
} from '@evenrealities/even_hub_sdk';

// State variables
let isMPH = true;
let flashState = false;  
let realSpeedKMH = 0;
let realRPM = 0;

// ELM327 BLE Characteristics (Standard UUIDs for cheap OBD2 dongles)
const OBD2_SERVICE_UUID = 0xFFF0; // Often FFF0 or FFE0
const OBD2_TX_UUID = 0xFFF2;      // Sending commands to car
const OBD2_RX_UUID = 0xFFF1;      // Receiving data from car

let obd2Device: BluetoothDevice | null = null;
let obd2TxCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;

// --- DOM ELEMENTS ---
const statusBadge = document.getElementById('connectionStatus') as HTMLElement;
const connectBtn = document.getElementById('connectOBD2') as HTMLButtonElement;
const toggleBtn = document.getElementById('unitToggle') as HTMLButtonElement;

// --- UI LISTENERS ---
if (toggleBtn) {
  toggleBtn.addEventListener('click', () => {
    isMPH = !isMPH; 
    toggleBtn.innerText = `USING: ${isMPH ? 'MPH' : 'KM/H'}`;
  });
}

// --- BLUETOOTH OBD2 LOGIC ---
if (connectBtn) {
  connectBtn.addEventListener('click', async () => {
    try {
      statusBadge.innerText = "SEARCHING...";
      
      // 1. Request Bluetooth Device
      obd2Device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [OBD2_SERVICE_UUID] }],
        optionalServices: [OBD2_SERVICE_UUID]
      });

      // 2. Connect to GATT Server
      statusBadge.innerText = "CONNECTING...";
      const server = await obd2Device.gatt?.connect();
      const service = await server?.getPrimaryService(OBD2_SERVICE_UUID);
      
      obd2TxCharacteristic = await service?.getCharacteristic(OBD2_TX_UUID) || null;
      const rxCharacteristic = await service?.getCharacteristic(OBD2_RX_UUID);

      // 3. Start listening to the car's responses
      await rxCharacteristic?.startNotifications();
      rxCharacteristic?.addEventListener('characteristicvaluechanged', handleOBD2Response);

      statusBadge.innerText = "CONNECTED TO ECU";
      statusBadge.classList.add('connected');
      connectBtn.innerText = "Disconnect";
      
      // 4. Start the polling loop (Ask for Speed and RPM)
      startPollingCar();

    } catch (error) {
      console.error("Bluetooth Error:", error);
      statusBadge.innerText = "CONNECTION FAILED";
      statusBadge.classList.remove('connected');
    }
  });
}

// Parse the raw hex data coming back from the car engine
function handleOBD2Response(event: any) {
  const value = event.target.value;
  const decoder = new TextDecoder('utf-8');
  const response = decoder.decode(value).trim();

  // If the car replies to our Speed request (01 0D)
  if (response.includes('41 0D')) {
    const hexParts = response.split(' ');
    if (hexParts.length >= 3) {
      realSpeedKMH = parseInt(hexParts[2], 16);
    }
  }
  
  // If the car replies to our RPM request (01 0C)
  if (response.includes('41 0C')) {
    const hexParts = response.split(' ');
    if (hexParts.length >= 4) {
      const A = parseInt(hexParts[2], 16);
      const B = parseInt(hexParts[3], 16);
      realRPM = Math.round(((A * 256) + B) / 4);
    }
  }
}

// Ask the car for data every 500ms
async function startPollingCar() {
  if (!obd2TxCharacteristic) return;
  const encoder = new TextEncoder();
  
  setInterval(async () => {
    try {
      // Ask for Speed (01 0D)
      await obd2TxCharacteristic!.writeValue(encoder.encode('010D\r'));
      // Small delay, then ask for RPM (01 0C)
      setTimeout(async () => {
        await obd2TxCharacteristic!.writeValue(encoder.encode('010C\r'));
      }, 250);
    } catch (e) {
      console.log("Error requesting data");
    }
  }, 500);
}

// --- GLASSES HUD LOGIC (Unchanged Peripheral Layout) ---
function calculateGear(speedKMH: number): string {
  const mph = speedKMH / 1.609;
  if (mph === 0) return 'N ';
  if (mph <= 15) return '1st';
  if (mph <= 30) return '2nd';
  if (mph <= 50) return '3rd';
  if (mph <= 70) return '4th';
  return '5th';
}

function createRPMBar(rpm: number, maxRpm: number = 4500): string {
  const barLength = 16; 
  const fillCount = Math.max(0, Math.min(barLength, Math.floor((rpm / maxRpm) * barLength)));
  const emptyCount = barLength - fillCount;
  return `[${'█'.repeat(fillCount)}${'-'.repeat(emptyCount)}]`;
}

async function startHUD() {
  const bridge = await waitForEvenAppBridge();

  await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [new TextContainerProperty({ containerID: 1, content: '', isEventCapture: 0 })]
  }));

  // Update the glasses every 400ms with whatever the latest real data is
  setInterval(async () => {
    const displaySpeed = isMPH ? Math.round(realSpeedKMH / 1.609) : realSpeedKMH;
    const unitLabel = isMPH ? 'MPH' : 'KM/H';
    const currentGear = calculateGear(realSpeedKMH);
    const rpmBar = createRPMBar(realRPM);
    
    flashState = !flashState;

    const speedContainer = new TextContainerProperty({
      containerID: 1, content: `${displaySpeed} ${unitLabel}`, 
      xPosition: 20, yPosition: 20, width: 150, height: 40, isEventCapture: 0
    });

    const gearContainer = new TextContainerProperty({
      containerID: 2, content: `GEAR: ${currentGear}`,
      xPosition: 440, yPosition: 20, width: 120, height: 40, isEventCapture: 0
    });

    const gaugeContainer = new TextContainerProperty({
      containerID: 3, content: `RPM: ${rpmBar} ${realRPM}`,
      xPosition: 120, yPosition: 240, width: 400, height: 40, isEventCapture: 0
    });

    const containersToSend = [speedContainer, gearContainer, gaugeContainer];

    if (realRPM > 3500 && flashState) { 
      containersToSend.push(new TextContainerProperty({
        containerID: 4, content: "!!! SHIFT UP !!!",
        xPosition: 210, yPosition: 120, width: 200, height: 50, isEventCapture: 0
      }));
    }

    await bridge.rebuildPageContainer(new RebuildPageContainer({
      containerTotalNum: containersToSend.length, 
      textObject: containersToSend
    }));
    
  }, 400); 
}

startHUD();