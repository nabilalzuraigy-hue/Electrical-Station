import 'package:path/path.dart';
import 'package:sqflite/sqflite.dart';

import '../models/meter_reading.dart';
import '../models/payment_receipt.dart';
import '../models/station_config.dart';
import '../models/subscriber.dart';

class DatabaseHelper {
  static final DatabaseHelper instance = DatabaseHelper._init();
  static Database? _database;

  DatabaseHelper._init();

  Future<Database> get database async {
    if (_database != null) return _database!;
    _database = await _initDB('yemen_power_station.db');
    return _database!;
  }

  Future<Database> _initDB(String filePath) async {
    final dbPath = await getDatabasesPath();
    final path = join(dbPath, filePath);

    return openDatabase(
      path,
      version: 2,
      onCreate: _createDB,
      onUpgrade: (db, oldVersion, newVersion) async {
        if (oldVersion < 2) {
          await db.execute(
              "ALTER TABLE station_config ADD COLUMN license_code TEXT NOT NULL DEFAULT ''");
          await db.execute(
              "ALTER TABLE station_config ADD COLUMN license_status TEXT NOT NULL DEFAULT 'active'");
          await db.execute(
              "ALTER TABLE station_config ADD COLUMN max_collectors INTEGER NOT NULL DEFAULT 5");
          await db.execute(
              "ALTER TABLE station_config ADD COLUMN max_subscribers INTEGER NOT NULL DEFAULT 1500");
        }
      },
    );
  }

  Future<void> _createDB(Database db, int version) async {
    await db.execute('''
      CREATE TABLE station_config (
        station_id TEXT PRIMARY KEY,
        station_name TEXT NOT NULL,
        kwh_price_yer REAL NOT NULL,
        minimum_fee_yer REAL NOT NULL,
        main_generator_kwh REAL NOT NULL,
        license_code TEXT NOT NULL DEFAULT '',
        license_status TEXT NOT NULL DEFAULT 'active',
        max_collectors INTEGER NOT NULL DEFAULT 5,
        max_subscribers INTEGER NOT NULL DEFAULT 1500,
        owner_uid TEXT NOT NULL
      )
    ''');

    await db.execute('''
      CREATE TABLE subscribers (
        id TEXT PRIMARY KEY,
        meter_number TEXT NOT NULL UNIQUE,
        subscriber_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        previous_reading REAL NOT NULL,
        current_reading REAL NOT NULL,
        previous_debt_yer REAL NOT NULL,
        zone_street TEXT NOT NULL,
        sequence_order INTEGER NOT NULL,
        assigned_collector_id TEXT,
        sync_status TEXT NOT NULL DEFAULT 'synced',
        updated_at TEXT NOT NULL
      )
    ''');

    await db.execute(
        'CREATE INDEX idx_subscribers_route ON subscribers(zone_street, sequence_order)');
    await db.execute(
        'CREATE INDEX idx_subscribers_meter ON subscribers(meter_number)');

    await db.execute('''
      CREATE TABLE meter_readings (
        id TEXT PRIMARY KEY,
        subscriber_id TEXT NOT NULL,
        meter_number TEXT NOT NULL,
        subscriber_name TEXT NOT NULL,
        previous_reading REAL NOT NULL,
        current_reading REAL NOT NULL,
        consumption_kwh REAL NOT NULL,
        kwh_price_yer REAL NOT NULL,
        current_bill_yer REAL NOT NULL,
        previous_debt_yer REAL NOT NULL,
        total_due_yer REAL NOT NULL,
        photo_local_path TEXT NOT NULL,
        photo_cloud_url TEXT,
        photo_size_kb REAL NOT NULL,
        collector_uid TEXT NOT NULL,
        collector_name TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        sync_status TEXT NOT NULL DEFAULT 'pending'
      )
    ''');

    await db.execute('''
      CREATE TABLE payment_receipts (
        id TEXT PRIMARY KEY,
        subscriber_id TEXT NOT NULL,
        meter_number TEXT NOT NULL,
        subscriber_name TEXT NOT NULL,
        reading_id TEXT NOT NULL,
        amount_paid_yer REAL NOT NULL,
        remaining_balance_yer REAL NOT NULL,
        collector_uid TEXT NOT NULL,
        collector_name TEXT NOT NULL,
        paid_at TEXT NOT NULL,
        sync_status TEXT NOT NULL DEFAULT 'pending'
      )
    ''');
  }

  Future<void> saveStationConfig(StationConfig config) async {
    final db = await database;
    await db.insert(
      'station_config',
      config.toSqliteMap(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<StationConfig?> getStationConfig() async {
    final db = await database;
    final rows = await db.query('station_config', limit: 1);
    if (rows.isEmpty) return null;
    return StationConfig.fromSqliteMap(rows.first);
  }

  Future<void> batchUpsertSubscribers(List<Subscriber> subscribers) async {
    final db = await database;
    await db.transaction((txn) async {
      final batch = txn.batch();
      for (final sub in subscribers) {
        batch.insert(
          'subscribers',
          sub.toSqliteMap(),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      }
      await batch.commit(noResult: true);
    });
  }

  Future<List<Subscriber>> getRouteSubscribers({
    String? zoneStreet,
    String? query,
  }) async {
    final db = await database;
    final whereClauses = <String>[];
    final whereArgs = <dynamic>[];

    if (zoneStreet != null && zoneStreet.isNotEmpty) {
      whereClauses.add('zone_street = ?');
      whereArgs.add(zoneStreet);
    }

    if (query != null && query.trim().isNotEmpty) {
      final q = '%${query.trim()}%';
      whereClauses.add('(meter_number LIKE ? OR subscriber_name LIKE ?)');
      whereArgs.addAll([q, q]);
    }

    final rows = await db.query(
      'subscribers',
      where: whereClauses.isEmpty ? null : whereClauses.join(' AND '),
      whereArgs: whereArgs.isEmpty ? null : whereArgs,
      orderBy: 'sequence_order ASC, meter_number ASC',
    );
    return rows.map(Subscriber.fromSqliteMap).toList();
  }

  Future<void> saveOfflineReadingAndUpdateSubscriber({
    required MeterReading reading,
    required Subscriber updatedSubscriber,
  }) async {
    final db = await database;
    await db.transaction((txn) async {
      await txn.insert(
        'meter_readings',
        reading.toSqliteMap(),
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
      await txn.update(
        'subscribers',
        updatedSubscriber.copyWith(syncStatus: 'pending').toSqliteMap(),
        where: 'id = ?',
        whereArgs: [updatedSubscriber.id],
      );
    });
  }

  Future<void> saveOfflinePaymentReceipt({
    required PaymentReceipt receipt,
    required String subscriberId,
    required double remainingDebtYer,
  }) async {
    final db = await database;
    await db.transaction((txn) async {
      await txn.insert(
        'payment_receipts',
        receipt.toSqliteMap(),
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
      await txn.update(
        'subscribers',
        {
          'previous_debt_yer': remainingDebtYer,
          'sync_status': 'pending',
          'updated_at': DateTime.now().toIso8601String(),
        },
        where: 'id = ?',
        whereArgs: [subscriberId],
      );
    });
  }

  Future<List<MeterReading>> getPendingReadings() async {
    final db = await database;
    final rows = await db.query(
      'meter_readings',
      where: "sync_status = 'pending'",
      orderBy: 'recorded_at ASC',
    );
    return rows.map(MeterReading.fromSqliteMap).toList();
  }

  Future<List<PaymentReceipt>> getPendingReceipts() async {
    final db = await database;
    final rows = await db.query(
      'payment_receipts',
      where: "sync_status = 'pending'",
      orderBy: 'paid_at ASC',
    );
    return rows.map(PaymentReceipt.fromSqliteMap).toList();
  }

  Future<List<Subscriber>> getPendingSubscribers() async {
    final db = await database;
    final rows = await db.query(
      'subscribers',
      where: "sync_status = 'pending'",
    );
    return rows.map(Subscriber.fromSqliteMap).toList();
  }

  Future<void> markReadingSynced(String id, String cloudPhotoUrl) async {
    final db = await database;
    await db.update(
      'meter_readings',
      {'sync_status': 'synced', 'photo_cloud_url': cloudPhotoUrl},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  Future<void> markReceiptSynced(String id) async {
    final db = await database;
    await db.update(
      'payment_receipts',
      {'sync_status': 'synced'},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  Future<void> markSubscriberSynced(String id) async {
    final db = await database;
    await db.update(
      'subscribers',
      {'sync_status': 'synced'},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  Future<int> getPendingSyncCount() async {
    final db = await database;
    final r1 = Sqflite.firstIntValue(await db.rawQuery(
            "SELECT COUNT(*) FROM meter_readings WHERE sync_status = 'pending'")) ??
        0;
    final r2 = Sqflite.firstIntValue(await db.rawQuery(
            "SELECT COUNT(*) FROM payment_receipts WHERE sync_status = 'pending'")) ??
        0;
    return r1 + r2;
  }

  Future<List<MeterReading>> getAllReadings() async {
    final db = await database;
    final rows = await db.query('meter_readings', orderBy: 'recorded_at DESC');
    return rows.map(MeterReading.fromSqliteMap).toList();
  }

  Future<List<PaymentReceipt>> getAllReceipts() async {
    final db = await database;
    final rows = await db.query('payment_receipts', orderBy: 'paid_at DESC');
    return rows.map(PaymentReceipt.fromSqliteMap).toList();
  }
}
