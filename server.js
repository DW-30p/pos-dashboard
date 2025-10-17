// server.js - Backend API Completo
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuración de PostgreSQL (Neon)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Test de conexión
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error conectando a la base de datos:', err.stack);
  } else {
    console.log('✅ Conexión exitosa a la base de datos');
    release();
  }
});

// =====================================================
// HEALTH CHECK
// =====================================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'API funcionando correctamente' });
});

// =====================================================
// DASHBOARD - ESTADÍSTICAS GENERALES
// =====================================================
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    
    // Ventas del período
    const salesQuery = await pool.query(`
      SELECT 
        COUNT(*) as sales_count,
        COALESCE(SUM(total), 0) as total_sales,
        COALESCE(SUM(subtotal), 0) as subtotal_sales,
        COALESCE(SUM(tax), 0) as total_tax
      FROM sales
      WHERE date::date BETWEEN $1 AND $2
    `, [start_date, end_date]);

    // Ganancia
    const profitQuery = await pool.query(`
      SELECT 
        COALESCE(SUM((si.unit_price - si.unit_cost) * si.quantity), 0) as total_profit
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE s.date::date BETWEEN $1 AND $2
    `, [start_date, end_date]);

    // Caja actual
    const cashRegisterQuery = await pool.query(`
      SELECT current_balance 
      FROM cash_register 
      ORDER BY id DESC 
      LIMIT 1
    `);

    // Fiados pendientes
    const fiadosQuery = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total_fiados FROM fiados
    `);

    // Productos más vendidos
    const topProductsQuery = await pool.query(`
      SELECT 
        si.product_name,
        SUM(si.quantity) as total_quantity,
        SUM(si.subtotal) as total_revenue
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE s.date::date BETWEEN $1 AND $2
      GROUP BY si.product_name
      ORDER BY total_revenue DESC
      LIMIT 10
    `, [start_date, end_date]);

    // Ventas recientes
    const recentSalesQuery = await pool.query(`
      SELECT id, date, total, ncf, payment_method
      FROM sales
      ORDER BY date DESC
      LIMIT 10
    `);

    // Productos con stock bajo
    const lowStockQuery = await pool.query(`
      SELECT name, stock, min_stock
      FROM products
      WHERE stock <= min_stock
      ORDER BY stock ASC
      LIMIT 10
    `);

    res.json({
      sales: salesQuery.rows[0],
      profit: profitQuery.rows[0],
      cashRegister: cashRegisterQuery.rows[0]?.current_balance || 0,
      fiados: fiadosQuery.rows[0].total_fiados,
      topProducts: topProductsQuery.rows,
      recentSales: recentSalesQuery.rows,
      lowStock: lowStockQuery.rows
    });
  } catch (error) {
    console.error('Error en dashboard stats:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas', details: error.message });
  }
});

// =====================================================
// VENTAS
// =====================================================
app.get('/api/sales', async (req, res) => {
  try {
    const { start_date, end_date, limit = 50, offset = 0 } = req.query;
    
    let query = `
      SELECT 
        s.id, s.date, s.total, s.subtotal, s.tax,
        s.payment_method, s.ncf, s.amount_paid, s.change,
        c.name as customer_name, u.username as user_name
      FROM sales s
      LEFT JOIN customers c ON s.customer_id = c.id
      LEFT JOIN users u ON s.user_id = u.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (start_date && end_date) {
      params.push(start_date, end_date);
      query += ` AND s.date::date BETWEEN $1 AND $2`;
    }
    
    query += ` ORDER BY s.date DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const result = await pool.query(query, params);
    
    res.json({
      sales: result.rows,
      total: result.rowCount
    });
  } catch (error) {
    console.error('Error al obtener ventas:', error);
    res.status(500).json({ error: 'Error al obtener ventas' });
  }
});

app.get('/api/sales/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const saleQuery = await pool.query(`
      SELECT s.*, c.name as customer_name, u.username as user_name
      FROM sales s
      LEFT JOIN customers c ON s.customer_id = c.id
      LEFT JOIN users u ON s.user_id = u.id
      WHERE s.id = $1
    `, [id]);
    
    if (saleQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Venta no encontrada' });
    }
    
    const itemsQuery = await pool.query(`
      SELECT product_name, product_number, quantity, unit_price, unit_cost, subtotal
      FROM sale_items WHERE sale_id = $1
    `, [id]);
    
    res.json({
      sale: saleQuery.rows[0],
      items: itemsQuery.rows
    });
  } catch (error) {
    console.error('Error al obtener detalle de venta:', error);
    res.status(500).json({ error: 'Error al obtener detalle de venta' });
  }
});

// =====================================================
// PRODUCTOS E INVENTARIO
// =====================================================
app.get('/api/products', async (req, res) => {
  try {
    const { search, category_id, low_stock } = req.query;
    
    let query = `
      SELECT p.*, c.name as category_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.available = true
    `;
    
    const params = [];
    
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (p.name ILIKE $${params.length} OR p.barcode ILIKE $${params.length})`;
    }
    
    if (category_id) {
      params.push(category_id);
      query += ` AND p.category_id = $${params.length}`;
    }
    
    if (low_stock === 'true') {
      query += ` AND p.stock <= p.min_stock`;
    }
    
    query += ` ORDER BY p.name`;
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener productos:', error);
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

app.get('/api/products/stats', async (req, res) => {
  try {
    const totalProducts = await pool.query(`
      SELECT COUNT(*) as total FROM products WHERE available = true
    `);
    
    const lowStock = await pool.query(`
      SELECT COUNT(*) as total FROM products WHERE stock <= min_stock AND available = true
    `);
    
    const outOfStock = await pool.query(`
      SELECT COUNT(*) as total FROM products WHERE stock = 0 AND available = true
    `);
    
    res.json({
      total: parseInt(totalProducts.rows[0].total),
      lowStock: parseInt(lowStock.rows[0].total),
      outOfStock: parseInt(outOfStock.rows[0].total)
    });
  } catch (error) {
    console.error('Error en stats de productos:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// =====================================================
// REPORTES
// =====================================================
app.get('/api/reports/profit', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    
    const result = await pool.query(`
      SELECT 
        DATE(s.date) as sale_date,
        SUM(si.subtotal) as total_revenue,
        SUM(si.unit_cost * si.quantity) as total_cost,
        SUM((si.unit_price - si.unit_cost) * si.quantity) as total_profit,
        ROUND((SUM((si.unit_price - si.unit_cost) * si.quantity) / NULLIF(SUM(si.subtotal), 0) * 100), 2) as profit_margin
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE s.date::date BETWEEN $1 AND $2
      GROUP BY DATE(s.date)
      ORDER BY sale_date DESC
    `, [start_date, end_date]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error en reporte de ganancias:', error);
    res.status(500).json({ error: 'Error al generar reporte' });
  }
});

app.get('/api/reports/payment-methods', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    
    const result = await pool.query(`
      SELECT 
        payment_method,
        COUNT(*) as transaction_count,
        SUM(total) as total_amount
      FROM sales
      WHERE date::date BETWEEN $1 AND $2
      GROUP BY payment_method
      ORDER BY total_amount DESC
    `, [start_date, end_date]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error en reporte de métodos de pago:', error);
    res.status(500).json({ error: 'Error al generar reporte' });
  }
});

// =====================================================
// CLIENTES
// =====================================================
app.get('/api/customers', async (req, res) => {
  try {
    const { search } = req.query;
    
    let query = `
      SELECT c.*, COALESCE(SUM(f.amount), 0) as total_fiados
      FROM customers c
      LEFT JOIN fiados f ON c.id = f.customer_id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (c.name ILIKE $1 OR c.phone ILIKE $1 OR c.cedula ILIKE $1)`;
    }
    
    query += ` GROUP BY c.id ORDER BY c.name`;
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener clientes:', error);
    res.status(500).json({ error: 'Error al obtener clientes' });
  }
});

// =====================================================
// SERVIDOR
// =====================================================
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📊 Dashboard disponible en http://localhost:${PORT}`);
});