# วิธีการคำนวณต้นทุนสินค้าคงคลัง: ต้นทุนถัวเฉลี่ย (Weighted Average)

## 1. ภาพรวม

**ต้นทุนถัวเฉลี่ย (Weighted Average)**: สินค้าทั้งหมดจะถูกตีมูลค่าด้วยต้นทุนถัวเฉลี่ยถ่วงน้ำหนัก สินค้าทุกหน่วยในคลังมีต้นทุนเท่ากัน ณ เวลาใดเวลาหนึ่ง

ใช้กำหนด **ต้นทุนสินค้าขาย (COGS)** และ **มูลค่าสินค้าคงเหลือปลายงวด** ซึ่งส่งผลโดยตรงต่อการรายงานทางการเงินและการตัดสินใจด้านการดำเนินงาน

---

## 2. แนวคิด

ต้นทุนถัวเฉลี่ยจะรวมต้นทุนของสินค้าทั้งหมดที่มีอยู่เป็นค่าเฉลี่ยถ่วงน้ำหนักเดียว สินค้าทุกหน่วยในคลังมีต้นทุนเท่ากัน ณ เวลาใดเวลาหนึ่ง

### 2.1 วิธีการทำงาน

```
ยอดเปิด:        0 หน่วย @ ฿0.00    | ต้นทุนเฉลี่ย = ฿0.00

ซื้อครั้งที่ 1:  100 หน่วย @ ฿10.00
  รวม:          100 หน่วย, มูลค่า = ฿1,000.00
  ต้นทุนเฉลี่ย = ฿1,000.00 / 100 = ฿10.00

ซื้อครั้งที่ 2:   50 หน่วย @ ฿12.00
  รวม:          150 หน่วย, มูลค่า = ฿1,000.00 + ฿600.00 = ฿1,600.00
  ต้นทุนเฉลี่ย = ฿1,600.00 / 150 = ฿10.6667

เบิกออก 120 หน่วย:
  ต้นทุนสินค้าขาย = 120 * ฿10.6667 = ฿1,280.00

คงเหลือ:         30 หน่วย * ฿10.6667 = ฿320.00

ซื้อครั้งที่ 3:   80 หน่วย @ ฿11.50
  รวม:          110 หน่วย, มูลค่า = ฿320.00 + ฿920.00 = ฿1,240.00
  ต้นทุนเฉลี่ย = ฿1,240.00 / 110 = ฿11.2727
```

---

## 3. โมเดลข้อมูล

ไม่ต้องติดตามล็อต แต่ละคู่สินค้า-คลังสินค้าจะเก็บค่าเฉลี่ยที่คำนวณต่อเนื่อง:

```
inventory_balance (ยอดคงเหลือสินค้าคงคลัง):
  - product_id       (FK, composite PK)
  - warehouse_id     (FK, composite PK)
  - quantity          (decimal)         -- จำนวนคงเหลือปัจจุบัน
  - average_cost      (decimal)         -- ต้นทุนถัวเฉลี่ยถ่วงน้ำหนักปัจจุบัน
  - total_value       (decimal)         -- quantity * average_cost
  - updated_at        (timestamp)

inventory_transaction (รายการเคลื่อนไหวสินค้า):
  - transaction_id   (PK)
  - product_id       (FK)
  - warehouse_id     (FK)
  - transaction_type (enum: IN, OUT, ADJUST)  -- รับเข้า, เบิกออก, ปรับปรุง
  - quantity          (decimal)
  - unit_cost         (decimal)         -- ต้นทุนเฉลี่ย ณ เวลาที่ทำรายการ
  - total_cost        (decimal)
  - reference_doc     (varchar)
  - created_at        (timestamp)
```

---

## 4. อัลกอริทึม

```
function receiveStock_AVG(productId, warehouseId, receivedQty, purchaseCost):
    balance = getBalance(productId, warehouseId)

    newTotalValue = (balance.quantity * balance.average_cost)
                  + (receivedQty * purchaseCost)
    newTotalQty   = balance.quantity + receivedQty
    newAvgCost    = newTotalValue / newTotalQty

    balance.quantity     = newTotalQty
    balance.average_cost = newAvgCost
    balance.total_value  = newTotalValue

    recordTransaction(IN, receivedQty, purchaseCost)


function issueStock_AVG(productId, warehouseId, requiredQty):
    balance = getBalance(productId, warehouseId)

    if balance.quantity < requiredQty:
        throw InsufficientStockError  // สินค้าไม่เพียงพอ

    totalCost = requiredQty * balance.average_cost

    balance.quantity    -= requiredQty
    balance.total_value -= totalCost
    // ต้นทุนเฉลี่ยไม่เปลี่ยนแปลงเมื่อเบิกออก

    recordTransaction(OUT, requiredQty, balance.average_cost)

    return totalCost
```

---

## 5. ข้อดีและข้อเสีย

### 5.1 ข้อดี

| ข้อดี | รายละเอียด |
|-------|-----------|
| โมเดลข้อมูลง่ายกว่า | ไม่ต้องติดตามล็อต |
| การดำเนินงานเร็วกว่า | O(1) สำหรับทั้งการรับเข้าและเบิกออก |
| ใช้พื้นที่จัดเก็บน้อยกว่า | เรคคอร์ดเดียวต่อคู่สินค้า-คลังสินค้า |
| ลดผลกระทบจากราคาผันผวน | ลดผลกระทบจากความผันผวนของราคา |

### 5.2 ข้อเสีย

| ข้อเสีย | รายละเอียด |
|---------|-----------|
| ไม่สามารถตรวจสอบย้อนกลับต้นทุนได้ | ไม่สามารถตรวจสอบต้นทุนย้อนกลับไปยังการซื้อเฉพาะได้ |
| ปัญหาการปัดเศษ | การคำนวณซ้ำอาจสะสมความคลาดเคลื่อนจากการปัดเศษ |
| ไม่เหมาะกับสินค้าเน่าเสีย | ไม่มีการติดตามแบตช์/วันหมดอายุในตัว |
| ความซับซ้อนในการคำนวณใหม่ | การแก้ไขข้อผิดพลาดในอดีตต้องคำนวณรายการที่ตามมาทั้งหมดใหม่ |

---

## 6. กรณีพิเศษที่ต้องจัดการ

| กรณีพิเศษ | การจัดการแบบต้นทุนถัวเฉลี่ย |
|-----------|---------------------------|
| **สต๊อกเป็นศูนย์ + รับเข้า** | ตั้งต้นทุนเฉลี่ย = ต้นทุนซื้อ |
| **คืนสินค้าให้ผู้ขาย** | คำนวณค่าเฉลี่ยใหม่ |
| **ลูกค้าคืนสินค้า** | คำนวณค่าเฉลี่ยใหม่ด้วยต้นทุนสินค้าคืน |
| **ปรับปรุงสต๊อก (+)** | คำนวณค่าเฉลี่ยใหม่ |
| **ปรับปรุงสต๊อก (-)** | ลดจำนวน คงต้นทุนเฉลี่ยเดิม |
| **โอนย้ายระหว่างคลัง** | เบิกออกด้วยต้นทุนเฉลี่ย รับเข้าด้วยต้นทุนเดียวกัน |
| **สต๊อกติดลบ (ถ้าอนุญาต)** | อนุญาตจำนวนติดลบ คงต้นทุนเฉลี่ย |
| **การปัดเศษ** | เสี่ยงสะสมคลาดเคลื่อน - ใช้ความละเอียดสูง |
| **ใบลดหนี้ (Credit Note)** | ปรับล็อต + คำนวณค่าเฉลี่ยใหม่ (Cost Layer) |
| **ปิด/เปิดงวดบัญชี** | snapshot ยอดรวม + ยกยอดล็อตเดียว (Cost Layer) |

---

## 7. Cost Layer Average

### 7.1 ภาพรวม

Cost Layer Average เป็นส่วนขยายของต้นทุนถัวเฉลี่ยมาตรฐาน โดยเพิ่มความสามารถเพิ่มเติมสำหรับการจัดการระดับองค์กร:

- **จัดการงวดบัญชี (Period Management)** — ปิด/เปิดงวดเพื่อตัดยอดสิ้นงวดและยกยอดข้ามงวด
- **ติดตามผลต่างการปัดเศษ (Rounding Diff)** — สะสมผลต่างจากการปัดเศษในแต่ละรายการ
- **ใบลดหนี้ (Credit Note)** — ปรับปรุงล็อตเฉพาะเจาะจง
- **บันทึกรายการ (Transaction Log)** — audit trail เต็มรูปแบบพร้อม seq, period, avgUnitCost

### 7.2 ประเภทรายการเพิ่มเติม

| ประเภท | คำอธิบาย |
|--------|---------|
| `TRANSFER_OUT` | เบิกออกจากคลังต้นทาง (ที่ต้นทุนเฉลี่ย) |
| `TRANSFER_IN` | รับเข้าคลังปลายทาง (สร้างล็อตใหม่ที่ต้นทุนเฉลี่ย) |
| `CREDIT_NOTE` | ปรับปรุงจำนวนในล็อตเฉพาะ (ใบลดหนี้) |
| `CLOSE` | ปิดงวดบัญชี — ตัดยอดสินค้าคงเหลือพร้อมผลต่างสะสม |
| `OPEN` | เปิดงวดบัญชีใหม่ — ยกยอดเป็นล็อตเดียวที่ต้นทุนเฉลี่ย |

### 7.3 โมเดลข้อมูล Cost Layer Transaction

```
cost_layer_transaction (รายการเคลื่อนไหวแบบ Cost Layer):
  - id              (PK)
  - type            (enum: IN, OUT, TRANSFER_OUT, TRANSFER_IN,
                           CREDIT_NOTE, CLOSE, OPEN, ADJUST)
  - lot_id          (FK, nullable)     -- ล็อตที่เกี่ยวข้อง
  - in_qty          (decimal)          -- จำนวนรับเข้า
  - out_qty         (decimal)          -- จำนวนเบิกออก
  - unit_cost       (decimal)          -- ต้นทุนต่อหน่วย
  - diff            (decimal)          -- ผลต่างการปัดเศษ
  - avg_unit_cost   (decimal, nullable) -- ต้นทุนเฉลี่ย ณ ขณะนั้น
  - date            (timestamp)
  - location        (varchar)          -- รหัสคลังสินค้า
  - seq             (integer)          -- ลำดับรายการภายในคลัง
  - parent_lot_id   (FK, nullable)     -- ล็อตต้นทาง (สำหรับ issue/transfer)
  - period          (varchar)          -- งวดบัญชี (YYYY-MM)
  - reference_doc   (varchar, nullable)
```

### 7.4 การติดตามผลต่างการปัดเศษ (Rounding Diff)

ทุกครั้งที่คำนวณค่าเฉลี่ยใหม่ ผลต่างจากการปัดเศษจะถูกบันทึกและสะสม:

```
ตัวอย่าง:
  รับเข้า 2 หน่วย @ ฿33.33  → avg = ฿33.33
  รับเข้า 1 หน่วย @ ฿33.34  → avg = ฿33.3333
  รับเข้า 3 หน่วย @ ฿34.01  → avg = ฿33.6717
  รับเข้า 2 หน่วย @ ฿34.00  → avg = ฿33.7538

  ปิดงวด: diff = ฿-0.03 (ผลต่างสะสมจากการปัดเศษตลอดงวด)
```

### 7.5 การโอนย้าย

โอนย้ายที่ต้นทุนเฉลี่ยปัจจุบัน (ไม่แยกตามล็อต):

```
TRANSFER_OUT: 4 หน่วย @ ฿50.00 (avg cost)
TRANSFER_IN:  4 หน่วย @ ฿50.00 (สร้างล็อตใหม่ที่ปลายทาง)
```

### 7.6 การปิด/เปิดงวดบัญชี

```
ปิดงวด:
  1. บันทึกรายการ CLOSE รวมพร้อมผลต่างสะสม (diff)
  2. ตัดยอดเป็นศูนย์

เปิดงวด:
  1. สร้างล็อตเดียวที่ต้นทุนเฉลี่ยของงวดที่ปิด
  2. รีเซ็ตผลต่างสะสม (diff) เป็นศูนย์
  3. บันทึกรายการ OPEN
```

---

## 8. ตัวอย่างจาก Excel (Average)

สถานการณ์รับสินค้า 14 หน่วย มูลค่ารวม ฿480.03 แบ่งเป็น 5 ล็อต (3 ครั้ง) ที่คลัง MK:

```
ID    Type       Lot             In  Out  Per unit   Diff   Total    AVG/unit  Location  Seq  Period
C001  Receiving  MK-251102-01     2   0   33.33      -      66.66    33.33     MK         1   25-11
C002  Receiving  MK-251102-02     1   0   33.34      -     100.00    33.3333   MK         2   25-11
C003  Receiving  MK-251102-03     3   0   34.01      -     202.03    33.6717   MK         3   25-11
C004  Receiving  MK-251102-04     2   0   34.00      -     270.03    33.7538   MK         4   25-11
C005  Issue      -                0   4   33.7538    -     134.99    33.7538   MK         5   25-11
C006  Receiving  MK-251104-01     6   0   35.00      -     344.99    34.4990   MK         6   25-11
C007  Issue      -                0   4   34.4990    -     207.00    34.4990   MK         7   25-11
C008  CLOSE      -                0   6   34.50      -0.03    0.00   34.50     MK         8   25-11
C009  OPEN       MK-251201-01     6   0   34.50      -     207.00    34.50     MK         9   25-12
```

#### การคำนวณ Weighted Average ทีละขั้น

| ขั้น | คำนวณ | AVG/unit |
|------|--------|----------|
| C001 | 66.66 / 2 | 33.33 |
| C002 | (66.66 + 33.34) / 3 = 100.00 / 3 | 33.3333 |
| C003 | (100.00 + 102.03) / 6 = 202.03 / 6 | 33.6717 |
| C004 | (202.03 + 68.00) / 8 = 270.03 / 8 | 33.7538 |
| C005 | Issue 4 @ 33.7538 → เหลือ 4 units, value = 270.03 - 135.0152 ≈ 134.99 | 33.7538 |
| C006 | (134.99 + 210.00) / 10 = 344.99 / 10 | 34.4990 |
| C007 | Issue 4 @ 34.4990 → เหลือ 6 units, value = 344.99 - 137.9960 ≈ 207.00 | 34.4990 |
| C008 | Close: 6 × 34.50 = 207.00, diff = -0.03 (ปัดเศษสะสม) | - |

#### สรุปการเคลื่อนไหว

| รายการ | รายละเอียด |
|--------|-----------|
| รับเข้ารวม | 14 หน่วย = ฿480.03 |
| เบิกออกครั้งที่ 1 | 4 หน่วย @ ฿33.7538 = ฿135.02 |
| เบิกออกครั้งที่ 2 | 4 หน่วย @ ฿34.4990 = ฿138.00 |
| คงเหลือ | 6 หน่วย @ ฿34.50 = ฿207.00 |
| ผลต่างปัดเศษ (Diff) | ฿-0.03 (บันทึกเมื่อปิดงวด) |

> **หมายเหตุ**: ค่า AVG/unit ในตารางคำนวณด้วยความแม่นยำ 4 ตำแหน่ง (4dp)
> ตัวอย่างจาก Excel อาจใช้ 2dp ทำให้ค่าแตกต่างเล็กน้อย (เช่น 33.7538 vs 33.76)

---

## 9. สถาปัตยกรรม Strategy Pattern

```
interface InventoryCostingStrategy:
    receiveStock(productId, warehouseId, qty, cost)    // รับสินค้าเข้า
    issueStock(productId, warehouseId, qty) -> totalCost  // เบิกสินค้าออก
    adjustStock(productId, warehouseId, qty, cost)     // ปรับปรุงสต๊อก
    transferStock(from, to, qty)                       // โอนย้ายระหว่างคลัง
    getValuation(productId, warehouseId) -> value       // ดึงมูลค่าสินค้า
    recalculate(productId, warehouseId, fromDate)       // คำนวณใหม่

class AverageCostStrategy implements InventoryCostingStrategy:
    // การประมวลผลแบบถัวเฉลี่ยถ่วงน้ำหนัก

interface CostLayerCostingStrategy extends InventoryCostingStrategy:
    transferStockCostLayer(input) -> CostLayerTransferResult
    creditNote(input) -> CreditNoteResult
    closePeriod(input) -> ClosePeriodResult
    openPeriod(input) -> OpenPeriodResult
    getTransactionLog(productId, warehouseId) -> CostLayerTransaction[]
    getAccumulatedDiff(productId, warehouseId) -> number

class CostLayerAverageStrategy implements CostLayerCostingStrategy:
    // Weighted Average + diff tracking + credit note + period management
```

---

## 10. การคำนวณใหม่และการแก้ไขข้อผิดพลาด

เมื่อมีการแก้ไขรายการในอดีต รายการที่ตามมาทั้งหมดต้องถูกคำนวณใหม่:

```
function recalculate(productId, warehouseId, fromDate):
    // รีเซ็ตยอดคงเหลือไปยังสถานะก่อน fromDate
    balance = getSnapshotBefore(fromDate)

    // เล่นรายการทั้งหมดซ้ำตามลำดับเวลา
    transactions = getTransactions(productId, warehouseId, fromDate)
                    .orderBy(created_at ASC)

    for each txn in transactions:
        if txn.type == IN:
            strategy.receiveStock(txn.qty, txn.cost)
        else if txn.type == OUT:
            txn.updated_cost = strategy.issueStock(txn.qty)
            // อัปเดตเรคคอร์ดรายการด้วยต้นทุนที่แก้ไขแล้ว

    // บันทึกยอดคงเหลือสุดท้าย
    saveBalance(balance)
```

---

## 11. ข้อกำหนดด้านรายงาน

| รายงาน | คำอธิบาย | ข้อมูลต้นทุนถัวเฉลี่ย |
|--------|---------|---------------------|
| **มูลค่าสินค้าคงคลัง** | มูลค่าปัจจุบันของสินค้าคงคลังทั้งหมด | จำนวน * ต้นทุนเฉลี่ย |
| **รายงานต้นทุนสินค้าขาย** | ต้นทุนสินค้าที่เบิกออกในงวด | ต้นทุนเฉลี่ย ณ เวลาที่เบิก |
| **รายงานการเคลื่อนไหวสินค้า** | รายการรับเข้า/เบิกออกทั้งหมดพร้อมต้นทุน | ต้นทุนเฉลี่ยต่อรายการ |
| **รายงานอายุสินค้า** | อายุสินค้าตามล็อต | ไม่สามารถใช้ได้ |
| **ผลต่างราคา** | การเปลี่ยนแปลงราคาซื้อ | ถูกดูดซับเข้าค่าเฉลี่ย |

### เส้นทางการตรวจสอบ (Audit Trail)

ทุกรายการต้องบันทึก:
- ใครเป็นผู้ดำเนินการ
- เกิดขึ้นเมื่อใด
- อะไรเปลี่ยนแปลง (ค่าก่อน/หลัง)
- ทำไม (เอกสารอ้างอิง, รหัสเหตุผล)
- วิธีการคำนวณที่ใช้และรายละเอียดการคำนวณต้นทุน

---

## 12. คำแนะนำ

| สถานการณ์ | วิธีที่แนะนำ |
|-----------|-------------|
| สินค้าโภคภัณฑ์ / สินค้าจำนวนมาก | **ต้นทุนถัวเฉลี่ย** (ง่ายกว่า ราคาผันผวน) |
| ค้าปลีกปริมาณสูง | **ต้นทุนถัวเฉลี่ย** (ประสิทธิภาพ ความเรียบง่าย) |
| การผลิตด้วยวัตถุดิบ | **ต้นทุนถัวเฉลี่ย** (วัตถุดิบผสมรวมกัน) |
| ต้องจัดการงวดบัญชี + ใบลดหนี้ | **Cost Layer Average** (ปิด/เปิดงวด, CN) |
| ต้องการ audit trail ละเอียด + ติดตามผลต่างปัดเศษ | **Cost Layer Average** (diff tracking) |
