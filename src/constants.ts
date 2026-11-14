export const BOOTSTRAPPED_ADMIN_EMAIL = 'jsjg1023.305@gmail.com';
export const MAIN_WORKSPACE_ID = 'restaurante_principal';
export const APP_BRAND_NAME = 'The Fire Inventario';

export const MAX_NAME_LENGTH = 80;
export const MAX_AREA_LENGTH = 60;
export const MAX_DESC_LENGTH = 200;
export const MAX_UNIT_LENGTH = 24;
export const MAX_NOTES_LENGTH = 500;
export const MAX_EMAIL_LENGTH = 120;
export const MAX_STOCK_VALUE = 100000;
export const ID_PATTERN = /^[a-zA-Z0-9_\-]+$/;
export const DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

export interface DefaultStationTemplate {
  id: string;
  name: string;
  area: string;
  workerName: string;
  description: string;
}

export const DEFAULT_STATIONS: DefaultStationTemplate[] = [
  {
    id: 'mesera',
    name: 'Mesera — Gaseosas y Cervezas',
    area: 'Nevera y Barra',
    workerName: 'Mesera de turno',
    description: 'Gaseosas, cervezas, aguas, sodas, hielo y desechables de mesa.',
  },
  {
    id: 'salchipapas',
    name: 'Salchipapas y Jugos en Pulpa',
    area: 'Freidora y Barra de Jugos',
    workerName: 'Encargada de salchipapas',
    description: 'Papas, salchichas, chorizos, quesos, pulpas de fruta, limones y limonadas.',
  },
  {
    id: 'comida_rapida',
    name: 'Comida Rápida — Hamburguesas y Perros',
    area: 'Plancha y Armado',
    workerName: 'Encargada de comida rápida',
    description: 'Panes de hamburguesa y perro, carnes, salchichas, quesos, tocineta y salsas.',
  },
  {
    id: 'asados',
    name: 'Asados — Carnes y Pollos a la Plancha',
    area: 'Parrilla y Plancha',
    workerName: 'Encargado de asados',
    description: 'Cortes de carne, pechugas de pollo, lomo, costillas, acompañamientos y adobos.',
  },
];

export const UNIT_OPTIONS = [
  'und',
  'porción',
  'paq',
  'bolsa',
  'kg',
  'g',
  'L',
  'botella',
  'lata',
  'tajada',
  'caja',
];

export interface SeedItemTemplate {
  station: string;
  name: string;
  unit: string;
  minStock: number;
  targetStock: number;
}

export const DEFAULT_CATALOG_ITEMS: SeedItemTemplate[] = [
  // 1. Mesera — Gaseosas, Cervezas, etc.
  { station: 'mesera', name: 'Coca-Cola 400ml', unit: 'und', minStock: 12, targetStock: 36 },
  { station: 'mesera', name: 'Coca-Cola Zero 400ml', unit: 'und', minStock: 6, targetStock: 18 },
  { station: 'mesera', name: 'Postobón Manzana / Colombiana', unit: 'und', minStock: 10, targetStock: 24 },
  { station: 'mesera', name: 'Agua sin gas 600ml', unit: 'und', minStock: 10, targetStock: 24 },
  { station: 'mesera', name: 'Cerveza Águila / Poker', unit: 'und', minStock: 12, targetStock: 36 },
  { station: 'mesera', name: 'Cerveza Club Colombia', unit: 'und', minStock: 8, targetStock: 24 },
  { station: 'mesera', name: 'Soda / Bretaña', unit: 'und', minStock: 6, targetStock: 18 },
  { station: 'mesera', name: 'Hielo en bolsa', unit: 'bolsa', minStock: 2, targetStock: 6 },
  { station: 'mesera', name: 'Vasos y pitillos desechables', unit: 'paq', minStock: 2, targetStock: 5 },

  // 2. Salchipapas y Jugos en Pulpa
  { station: 'salchipapas', name: 'Papa francesa congelada', unit: 'bolsa', minStock: 4, targetStock: 12 },
  { station: 'salchipapas', name: 'Papa criolla', unit: 'kg', minStock: 3, targetStock: 10 },
  { station: 'salchipapas', name: 'Salchicha tipo ranchera', unit: 'paq', minStock: 4, targetStock: 12 },
  { station: 'salchipapas', name: 'Chorizo precocido', unit: 'paq', minStock: 2, targetStock: 6 },
  { station: 'salchipapas', name: 'Queso mozzarella rallado', unit: 'kg', minStock: 2, targetStock: 6 },
  { station: 'salchipapas', name: 'Maíz tierno dulce', unit: 'lata', minStock: 3, targetStock: 8 },
  { station: 'salchipapas', name: 'Pulpa de fruta (Mango / Mora / Lulo)', unit: 'paq', minStock: 6, targetStock: 18 },
  { station: 'salchipapas', name: 'Limón para limonada', unit: 'kg', minStock: 3, targetStock: 8 },
  { station: 'salchipapas', name: 'Azúcar', unit: 'kg', minStock: 2, targetStock: 6 },
  { station: 'salchipapas', name: 'Salsa tártara / rosada / piña', unit: 'L', minStock: 2, targetStock: 5 },
  { station: 'salchipapas', name: 'Bandejas y vasos de jugo', unit: 'paq', minStock: 2, targetStock: 6 },

  // 3. Comida Rápida — Hamburguesas y Perros
  { station: 'comida_rapida', name: 'Pan brioche hamburguesa', unit: 'und', minStock: 15, targetStock: 40 },
  { station: 'comida_rapida', name: 'Pan para perro caliente', unit: 'und', minStock: 12, targetStock: 36 },
  { station: 'comida_rapida', name: 'Carne de res 150g', unit: 'und', minStock: 15, targetStock: 40 },
  { station: 'comida_rapida', name: 'Salchicha americana para perro', unit: 'und', minStock: 12, targetStock: 36 },
  { station: 'comida_rapida', name: 'Queso cheddar / mozzarella tajado', unit: 'tajada', minStock: 15, targetStock: 45 },
  { station: 'comida_rapida', name: 'Tocineta ahumada', unit: 'paq', minStock: 3, targetStock: 8 },
  { station: 'comida_rapida', name: 'Papa ripio', unit: 'paq', minStock: 2, targetStock: 6 },
  { station: 'comida_rapida', name: 'Lechuga, tomate y cebolla', unit: 'kg', minStock: 2, targetStock: 6 },
  { station: 'comida_rapida', name: 'Salsas (BBQ, ajo, showy)', unit: 'L', minStock: 2, targetStock: 5 },
  { station: 'comida_rapida', name: 'Papel antigrasa y cajas', unit: 'paq', minStock: 2, targetStock: 5 },

  // 4. Asados — Carnes y Pollos a la Plancha
  { station: 'asados', name: 'Churrasco / Punta de anca', unit: 'porción', minStock: 8, targetStock: 24 },
  { station: 'asados', name: 'Pechuga de pollo a la plancha', unit: 'porción', minStock: 10, targetStock: 30 },
  { station: 'asados', name: 'Lomo de cerdo', unit: 'porción', minStock: 8, targetStock: 20 },
  { station: 'asados', name: 'Costilla de cerdo', unit: 'porción', minStock: 6, targetStock: 18 },
  { station: 'asados', name: 'Yuca y papa salada', unit: 'kg', minStock: 4, targetStock: 12 },
  { station: 'asados', name: 'Plátano maduro / patacón', unit: 'und', minStock: 10, targetStock: 30 },
  { station: 'asados', name: 'Chimichurri y adobo de asados', unit: 'L', minStock: 1, targetStock: 4 },
  { station: 'asados', name: 'Aceite de plancha / carbón', unit: 'L', minStock: 2, targetStock: 6 },
  { station: 'asados', name: 'Contenedores aluminio para llevar', unit: 'paq', minStock: 2, targetStock: 6 },
];
