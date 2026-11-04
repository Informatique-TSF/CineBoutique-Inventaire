using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Threading.Tasks;
using CineBoutique.Inventory.Api.Tests.Helpers;
using CineBoutique.Inventory.Api.Tests.Infrastructure;
using CineBoutique.Inventory.Api.Tests.Infra;
using CineBoutique.Inventory.Infrastructure.Migrations;
using FluentMigrator.Runner;
using FluentMigrator.Runner.Processors;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Npgsql;
using Xunit;

namespace CineBoutique.Inventory.Api.Tests.Fixtures;

public sealed class InventoryApiFixture : IAsyncLifetime, IAsyncDisposable
{
    private readonly object _gate = new();

    private PostgresContainerFixture? _postgres;
    private InventoryApiFactory? _factory;
    private Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program>? _shopAdminVerifyingFactory;
    private NpgsqlDataSource? _dataSource;
    private string? _connectionString;
    private bool _initialized;

    public TestDataSeeder Seeder { get; private set; } = default!;
    public bool IsBackendAvailable => TestDbOptions.UseExternalDb || GetOrCachePostgres().IsDatabaseAvailable;
    public string? SkipReason => GetOrCachePostgres().SkipReason;
    public TestAuditLogger AuditLogger
    {
        get
        {
            EnsureInitialized();
            return _factory!.Services.GetRequiredService<TestAuditLogger>();
        }
    }

    public void UsePostgresFixture(PostgresContainerFixture postgres)
    {
        _postgres = postgres ?? throw new ArgumentNullException(nameof(postgres));
    }

    public string ConnectionString
    {
        get
        {
            if (!IsBackendAvailable)
            {
                throw new InvalidOperationException("Le backend d'intégration n'est pas disponible.");
            }

            EnsureInitialized();
            return _connectionString!;
        }
    }

    // xUnit l’appelle si la fixture est enregistrée comme ICollectionFixture
    public async Task InitializeAsync()
    {
        if (!IsBackendAvailable)
            return;

        await EnsureReadyAsync().ConfigureAwait(false);
        // Reset initial pour partir propre sur la première classe qui l’utilise
        await DbResetAsync().ConfigureAwait(false);
    }

    public async Task DisposeAsync()
    {
        if (!_initialized)
            return;

        if (_shopAdminVerifyingFactory is not null)
        {
            await _shopAdminVerifyingFactory.DisposeAsync().ConfigureAwait(false);
            _shopAdminVerifyingFactory = null;
        }

        if (_factory is not null)
        {
            await _factory.DisposeAsync().ConfigureAwait(false);
            _factory = null;
        }

        if (_dataSource is not null)
        {
            await _dataSource.DisposeAsync().ConfigureAwait(false);
            _dataSource = null;
        }

        Seeder = null!;
        _connectionString = null;
        _initialized = false;
    }

    async ValueTask IAsyncDisposable.DisposeAsync()
    {
        if (_initialized)
            await DisposeAsync().ConfigureAwait(false);
    }

    /// <summary>
    /// Initialisation paresseuse et idempotente:
    /// - choisit la connection string (TEST_DB_CONN ou container)
    /// - applique les migrations
    /// - crée la factory et vérifie /ready
    /// - crée le seeder
    /// </summary>
    public async Task EnsureReadyAsync()
    {
        if (_initialized)
            return;

        // verrou léger pour éviter la double init en concurrence
        lock (_gate)
        {
            if (_initialized)
                return;
        }

        if (!IsBackendAvailable)
            return;

        var cs = TestDbOptions.UseExternalDb
            ? TestDbOptions.ExternalConnectionString!
            : GetOrCachePostgres().ConnectionString;

        if (string.IsNullOrWhiteSpace(cs))
            throw new InvalidOperationException("La chaîne de connexion de test doit être définie.");

        Environment.SetEnvironmentVariable("ASPNETCORE_ENVIRONMENT", "Testing");
        Environment.SetEnvironmentVariable("DOTNET_ENVIRONMENT", "Testing");
        // Ceinture + bretelles pour tout code qui lit la config via env:
        Environment.SetEnvironmentVariable("ConnectionStrings__Default", cs);

        _connectionString = cs;
        _dataSource = NpgsqlDataSource.Create(cs);

        await ApplyMigrationsAsync().ConfigureAwait(false);

        _factory = new InventoryApiFactory(cs);

        using (var client = _factory.CreateClient())
        {
            await WaitUntilReadyAsync(client).ConfigureAwait(false);
        }

        Seeder = new TestDataSeeder(_dataSource);

        lock (_gate) { _initialized = true; }
    }

    public HttpClient CreateClient()
    {
        EnsureInitialized();
        return _factory!.CreateClient();
    }

    public HttpClient Client => CreateClient();

    /// <summary>
    /// Client sur une API où le contrôle « administrateur réel de la boutique » est actif, comme en production.
    /// Les en-têtes d'opérateur par défaut (opérateur fictif) sont retirés : chaque test fournit les siens.
    /// </summary>
    public HttpClient CreateClientWithShopAdminVerification()
    {
        EnsureInitialized();

        lock (_gate)
        {
            // Ajoutée après la configuration de la fabrique parente (qui met « false ») : c'est elle qui l'emporte.
            _shopAdminVerifyingFactory ??= _factory!.WithWebHostBuilder(builder =>
                builder.ConfigureAppConfiguration((_, configuration) =>
                    configuration.AddInMemoryCollection(new Dictionary<string, string?>
                    {
                        ["Authorization:VerifyShopAdmin"] = "true"
                    })));
        }

        var client = _shopAdminVerifyingFactory.CreateClient();
        client.DefaultRequestHeaders.Remove("X-Operator-Id");
        client.DefaultRequestHeaders.Remove("X-Operator-Name");
        return client;
    }

    public void ClearAuditLogs()
    {
        if (!IsBackendAvailable)
        {
            return;
        }

        EnsureInitialized();
        AuditLogger.Clear();
    }

    public IReadOnlyList<AuditLogEntry> DrainAuditLogs()
    {
        if (!IsBackendAvailable)
        {
            return Array.Empty<AuditLogEntry>();
        }

        EnsureInitialized();
        return AuditLogger.Drain();
    }

    public async ValueTask<NpgsqlConnection> OpenConnectionAsync()
    {
        if (!IsBackendAvailable)
        {
            throw new InvalidOperationException("Le backend d'intégration n'est pas disponible.");
        }

        EnsureInitialized();
        return await _dataSource!.OpenConnectionAsync().ConfigureAwait(false);
    }

    public async Task DbResetAsync()
    {
        if (!IsBackendAvailable)
            return;

        await EnsureReadyAsync().ConfigureAwait(false);
        await ResetDatabaseSchemaAsync().ConfigureAwait(false);
        ClearAuditLogs();
    }

    public async Task ResetAndSeedAsync(Func<TestDataSeeder, Task> plan)
    {
        if (!IsBackendAvailable)
            return;

        ArgumentNullException.ThrowIfNull(plan);

        await DbResetAsync().ConfigureAwait(false);
        EnsureInitialized();

        // Les tests supposent désormais qu'une boutique par défaut est toujours disponible
        // (rétrocompatibilité avec les endpoints historiques). On la provisionne donc
        // systématiquement avant d'exécuter le plan de seed spécifique au scénario.
        _ = await Seeder.GetDefaultShopIdAsync().ConfigureAwait(false);

        await plan(Seeder).ConfigureAwait(false);
    }

    private void EnsureInitialized()
    {
        if (!_initialized || _dataSource is null || _factory is null || string.IsNullOrWhiteSpace(_connectionString))
            throw new InvalidOperationException("La fixture InventoryApiFixture n'est pas initialisée.");
    }

    private async Task ResetDatabaseSchemaAsync()
    {
        if (_dataSource is null)
            throw new InvalidOperationException("Le DataSource Postgres n'est pas initialisé.");

        await using var connection = await _dataSource.OpenConnectionAsync().ConfigureAwait(false);

        if (TestDbOptions.UseExternalDb)
        {
            const string truncateSql = @"DO $$
DECLARE
    stmt text;
BEGIN
    FOR stmt IN
        SELECT format('TRUNCATE TABLE %I.%I RESTART IDENTITY CASCADE;', schemaname, tablename)
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename <> 'VersionInfo'
    LOOP
        EXECUTE stmt;
    END LOOP;
END$$;";

            await using var truncateCommand = new NpgsqlCommand(truncateSql, connection);
            await truncateCommand.ExecuteNonQueryAsync().ConfigureAwait(false);
        }
        else
        {
            const string resetSql = "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;";
            await using var resetCommand = new NpgsqlCommand(resetSql, connection);
            await resetCommand.ExecuteNonQueryAsync().ConfigureAwait(false);
        }

        await ApplyMigrationsAsync().ConfigureAwait(false);
    }

    private async Task ApplyMigrationsAsync()
    {
        if (string.IsNullOrWhiteSpace(_connectionString))
            throw new InvalidOperationException("La chaîne de connexion de test n'est pas initialisée.");

        using var serviceProvider = BuildMigrationServiceProvider();
        using var scope = serviceProvider.CreateScope();
        var runner = scope.ServiceProvider.GetRequiredService<IMigrationRunner>();

        // MigrateUp n’est pas async, on le pousse dans un Task.Run contrôlé
        await Task.Run(() => runner.MigrateUp()).ConfigureAwait(false);
    }

    private ServiceProvider BuildMigrationServiceProvider()
    {
        if (string.IsNullOrWhiteSpace(_connectionString))
            throw new InvalidOperationException("La chaîne de connexion de test n'est pas initialisée.");

        var services = new ServiceCollection();

        services
            .AddFluentMigratorCore()
            .ConfigureRunner(rb => rb
                .AddPostgres()
                .WithGlobalConnectionString(_connectionString)
                .ScanIn(typeof(Program).Assembly, typeof(MigrationsAssemblyMarker).Assembly).For.Migrations())
            .AddLogging(lb => lb.AddFluentMigratorConsole());

        services.Configure<SelectingProcessorAccessorOptions>(options =>
        {
            options.ProcessorId = "Postgres";
        });

        services
            .AddOptions<ProcessorOptions>()
            .Configure(options =>
            {
                options.Timeout = TimeSpan.FromSeconds(90);
                options.ProviderSwitches = string.Empty;
                options.PreviewOnly = false;
            });

        services.AddSingleton(sp => sp.GetRequiredService<IOptions<ProcessorOptions>>().Value);

        return services.BuildServiceProvider();
    }

    private PostgresContainerFixture GetOrCachePostgres()
    {
        if (_postgres != null)
            return _postgres;

        var fixture = PostgresContainerFixture.Instance
            ?? throw new InvalidOperationException("PostgresContainerFixture n'est pas initialisée.");

        _postgres = fixture;
        return fixture;
    }

    private static async Task WaitUntilReadyAsync(HttpClient client)
    {
        for (var attempt = 0; attempt < 20; attempt++) // 20 au lieu de 10
        {
            var response = await client.GetAsync(client.CreateRelativeUri("/ready")).ConfigureAwait(false);
            if (response.IsSuccessStatusCode)
                return;

            await Task.Delay(TimeSpan.FromMilliseconds(300)).ConfigureAwait(false); // 300 ms
        }

        var finalResponse = await client.GetAsync(client.CreateRelativeUri("/ready")).ConfigureAwait(false);
        var payload = await finalResponse.Content.ReadAsStringAsync().ConfigureAwait(false);
        throw new InvalidOperationException($"API not ready. Status={finalResponse.StatusCode}, Payload={payload}");
    }

}
